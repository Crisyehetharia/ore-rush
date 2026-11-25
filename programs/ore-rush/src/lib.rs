//! ORE RUSH — a real-time mining game on a MagicBlock Ephemeral Rollup.
//!
//! Game flow (all on Solana devnet, no real funds):
//!   1. House operator calls `initialize_house` once, then `fund_pot` with devnet SOL.
//!   2. Player calls `start_round` (creates/resets their session PDA, 60s window).
//!   3. Player calls `delegate_session` (base layer) — the session PDA is
//!      delegated to the MagicBlock delegation program for the devnet-us ER.
//!   4. Player calls `mine` repeatedly on the ER (gasless, ~10ms) to grow score.
//!   5. Player calls `finish_round` on the ER — commits state back and
//!      undelegates the session to the program.
//!   6. Player calls `claim` on the base layer — if score >= min_score, the
//!      house vault pays the prize; the leaderboard is updated.
//!
//! The session account is the only delegated account; the house vault and
//! leaderboard never leave the base layer, so funds always settle on Solana.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::MagicIntentBundleBuilder;

declare_id!("FknaFskJcLQm3Tw4uRUEnMXvwa5xsED1FKB9NGyMY8HS");

pub const HOUSE_SEED: &[u8] = b"house";
pub const SESSION_SEED: &[u8] = b"session";
pub const LEADERBOARD_SEED: &[u8] = b"leaderboard";

/// Seconds per mining round.
pub const ROUND_DURATION: i64 = 60;
/// Minimum ores to win the prize.
pub const MIN_SCORE: u64 = 40;
/// Prize per winning round (0.05 devnet SOL).
pub const PRIZE_LAMPORTS: u64 = 50_000_000;
/// Leaderboard size.
pub const MAX_TOP: usize = 5;

/// Session status: 0 = idle/finished, 1 = round active.
pub const STATUS_IDLE: u8 = 0;
pub const STATUS_ACTIVE: u8 = 1;

#[ephemeral]
#[program]
pub mod ore_rush {
    use super::*;

    /// Create the house vault PDA and the leaderboard PDA (once, by the operator).
    pub fn initialize_house(ctx: Context<InitializeHouse>) -> Result<()> {
        let house = &mut ctx.accounts.house;
        house.authority = ctx.accounts.authority.key();
        house.prize_lamports = PRIZE_LAMPORTS;
        house.min_score = MIN_SCORE;
        house.round_duration = ROUND_DURATION;
        house.total_paid = 0;
        house.bump = ctx.bumps.house;
        msg!(
            "House initialized: prize {} lamports, min score {}, round {}s",
            PRIZE_LAMPORTS,
            MIN_SCORE,
            ROUND_DURATION
        );
        Ok(())
    }

    /// Top up the prize pot (anyone can fund; the demo funds it from the operator).
    pub fn fund_pot(ctx: Context<FundPot>, amount: u64) -> Result<()> {
        require!(amount > 0, OreRushError::InvalidAmount);
        let ix = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.funder.key(),
            &ctx.accounts.house.key(),
            amount,
        );
        anchor_lang::solana_program::program::invoke(
            &ix,
            &[
                ctx.accounts.funder.to_account_info(),
                ctx.accounts.house.to_account_info(),
            ],
        )?;
        msg!("Pot funded with {} lamports", amount);
        Ok(())
    }

    /// Start (or restart) a mining round for the player. Resets the score and
    /// opens a fresh 60s window. Refuses while a round is still active.
    pub fn start_round(ctx: Context<StartRound>) -> Result<()> {
        let clock = Clock::get()?;
        let session = &mut ctx.accounts.session;
        if session.status == STATUS_ACTIVE && clock.unix_timestamp < session.ends_at {
            return err!(OreRushError::RoundStillActive);
        }
        session.player = ctx.accounts.player.key();
        session.score = 0;
        session.started_at = clock.unix_timestamp;
        session.ends_at = clock.unix_timestamp + ctx.accounts.house.round_duration;
        session.status = STATUS_ACTIVE;
        session.claimed = false;
        session.bump = ctx.bumps.session;
        msg!(
            "Round started for {}: ends at {}",
            session.player,
            session.ends_at
        );
        Ok(())
    }

    /// Delegate the session PDA to the Ephemeral Rollup (base layer).
    /// The devnet-us validator pubkey must be passed as the first remaining
    /// account (its key only; no data is read).
    pub fn delegate_session(ctx: Context<DelegateSession>) -> Result<()> {
        ctx.accounts.delegate_session(
            &ctx.accounts.payer,
            &[SESSION_SEED, ctx.accounts.payer.key().as_ref()],
            DelegateConfig {
                validator: ctx.remaining_accounts.first().map(|acc| acc.key()),
                ..Default::default()
            },
        )?;
        msg!("Session delegated to Ephemeral Rollup");
        Ok(())
    }

    /// Mine one ore. Runs on the ER (gasless, real-time) but also works on the
    /// base layer. Only while the round window is open.
    pub fn mine(ctx: Context<Mine>) -> Result<()> {
        let clock = Clock::get()?;
        let session = &mut ctx.accounts.session;
        require!(session.status == STATUS_ACTIVE, OreRushError::NoActiveRound);
        require!(
            clock.unix_timestamp < session.ends_at,
            OreRushError::RoundOver
        );
        session.score = session.score.checked_add(1).ok_or(OreRushError::Overflow)?;
        require!(session.score <= 10_000, OreRushError::Overflow);
        Ok(())
    }

    /// Commit the ER session state back to the base layer and return the
    /// session PDA to this program. Must be sent to the ER.
    pub fn finish_round(ctx: Context<FinishRound>) -> Result<()> {
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.session.to_account_info()])
        .build_and_invoke()?;
        msg!("Round finished and session undelegated");
        Ok(())
    }

    /// Settle a finished round on the base layer. Pays the prize from the
    /// house vault when the score meets the minimum, updates the leaderboard,
    /// and closes the round. Only after the round window has ended.
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let clock = Clock::get()?;
        let session = &mut ctx.accounts.session;
        require!(session.status == STATUS_ACTIVE, OreRushError::NoActiveRound);
        require!(session.claimed == false, OreRushError::AlreadyClaimed);
        require!(
            clock.unix_timestamp >= session.ends_at,
            OreRushError::RoundNotOver
        );

        let won = session.score >= ctx.accounts.house.min_score;
        if won {
            let prize = ctx.accounts.house.prize_lamports;
            require!(
                ctx.accounts.house.to_account_info().lamports() >= prize,
                OreRushError::PotEmpty
            );
            // The house PDA carries data (it is owned by this program), so a
            // System Program transfer out of it is rejected by the runtime
            // ("Transfer: `from` must not carry data"). Move the lamports
            // directly instead — both accounts are writable in this ix.
            **ctx.accounts
                .house
                .to_account_info()
                .try_borrow_mut_lamports()? -= prize;
            **ctx.accounts
                .player
                .to_account_info()
                .try_borrow_mut_lamports()? += prize;
            ctx.accounts.house.total_paid = ctx
                .accounts
                .house
                .total_paid
                .checked_add(prize)
                .ok_or(OreRushError::Overflow)?;
            msg!(
                "Player {} won with score {} — paid {} lamports",
                session.player,
                session.score,
                prize
            );
        } else {
            msg!(
                "Player {} scored {} (min {}) — no prize",
                session.player,
                session.score,
                ctx.accounts.house.min_score
            );
        }

        // Leaderboard: keep the top 5 scores, sorted descending.
        let entry = LeaderEntry {
            player: session.player,
            score: session.score,
        };
        let board = &mut ctx.accounts.leaderboard;
        board.insert(entry);

        session.status = STATUS_IDLE;
        session.claimed = true;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeHouse<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + House::LEN,
        seeds = [HOUSE_SEED],
        bump
    )]
    pub house: Account<'info, House>,
    #[account(
        init,
        payer = authority,
        space = 8 + Leaderboard::LEN,
        seeds = [LEADERBOARD_SEED],
        bump
    )]
    pub leaderboard: Account<'info, Leaderboard>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FundPot<'info> {
    #[account(mut, seeds = [HOUSE_SEED], bump = house.bump)]
    pub house: Account<'info, House>,
    #[account(mut)]
    pub funder: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct StartRound<'info> {
    #[account(seeds = [HOUSE_SEED], bump = house.bump)]
    pub house: Account<'info, House>,
    #[account(
        init_if_needed,
        payer = player,
        space = 8 + Session::LEN,
        seeds = [SESSION_SEED, player.key().as_ref()],
        bump
    )]
    pub session: Account<'info, Session>,
    #[account(mut)]
    pub player: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// Delegate the session PDA to the ER. The PDA is an unchecked account here
/// because its owner changes to the delegation program.
#[delegate]
#[derive(Accounts)]
pub struct DelegateSession<'info> {
    pub payer: Signer<'info>,
    /// CHECK: the session PDA to delegate.
    #[account(mut, del)]
    pub session: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Mine<'info> {
    #[account(mut, seeds = [SESSION_SEED, player.key().as_ref()], bump = session.bump)]
    pub session: Account<'info, Session>,
    pub player: Signer<'info>,
}

/// Commit + undelegate the session from the ER. The `#[commit]` macro
/// injects the Magic Program / Magic Context accounts.
#[commit]
#[derive(Accounts)]
pub struct FinishRound<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [SESSION_SEED, payer.key().as_ref()], bump = session.bump)]
    pub session: Account<'info, Session>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut, seeds = [HOUSE_SEED], bump = house.bump)]
    pub house: Account<'info, House>,
    #[account(mut, seeds = [LEADERBOARD_SEED], bump)]
    pub leaderboard: Account<'info, Leaderboard>,
    #[account(mut, seeds = [SESSION_SEED, player.key().as_ref()], bump = session.bump)]
    pub session: Account<'info, Session>,
    #[account(mut)]
    pub player: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct House {
    pub authority: Pubkey,
    pub prize_lamports: u64,
    pub min_score: u64,
    pub round_duration: i64,
    pub total_paid: u64,
    pub bump: u8,
}

impl House {
    pub const LEN: usize = 32 + 8 + 8 + 8 + 8 + 1;
}

#[account]
pub struct Session {
    pub player: Pubkey,
    pub score: u64,
    pub started_at: i64,
    pub ends_at: i64,
    pub status: u8,
    pub claimed: bool,
    pub bump: u8,
}

impl Session {
    pub const LEN: usize = 32 + 8 + 8 + 8 + 1 + 1 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct LeaderEntry {
    pub player: Pubkey,
    pub score: u64,
}

#[account]
pub struct Leaderboard {
    pub entries: [LeaderEntry; MAX_TOP],
}

impl Leaderboard {
    pub const LEN: usize = MAX_TOP * (32 + 8);

    /// Insert an entry, keeping the top MAX_TOP scores sorted descending.
    /// Empty slots are zero-pubkey entries with score 0 and are replaced first.
    pub fn insert(&mut self, entry: LeaderEntry) {
        // Find the worst slot that this entry beats.
        let mut pos: Option<usize> = None;
        for (i, e) in self.entries.iter().enumerate() {
            if entry.score > e.score {
                pos = Some(i);
                break;
            }
        }
        if let Some(i) = pos {
            // Shift lower entries down by one, dropping the last.
            for j in (i + 1..MAX_TOP).rev() {
                self.entries[j] = self.entries[j - 1];
            }
            self.entries[i] = entry;
        }
    }
}

#[error_code]
pub enum OreRushError {
    #[msg("Amount must be greater than zero")]
    InvalidAmount,
    #[msg("A round is still active for this player")]
    RoundStillActive,
    #[msg("No active round for this player")]
    NoActiveRound,
    #[msg("The round window has ended")]
    RoundOver,
    #[msg("The round has not ended yet")]
    RoundNotOver,
    #[msg("This round was already claimed")]
    AlreadyClaimed,
    #[msg("The prize pot is empty")]
    PotEmpty,
    #[msg("Arithmetic overflow")]
    Overflow,
}
