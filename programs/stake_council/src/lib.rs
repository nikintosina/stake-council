//! stake_council — DAO-style management for stake pool operators.
//!
//! A council of wallets (e.g. 3) must reach a 2/3 supermajority before any
//! managerial action (fee change, stake re-distribution) is applied to the pool.
//! The pool's `manager` is the council PDA: a program-derived address with no
//! private key, so no single operator can ever act alone.
use anchor_lang::prelude::*;

declare_id!("CT73htzJtWZm27tc3fvcVy1iUrDxBPWv6abkNQidHVvM");

pub const MAX_MEMBERS: usize = 10;
pub const MAX_VALIDATORS: usize = 10;
pub const BPS_DENOMINATOR: u16 = 10_000;

#[program]
pub mod stake_council {
    use super::*;

    /// Create a council and the stake pool config it manages.
    pub fn initialize(
        ctx: Context<Initialize>,
        members: Vec<Pubkey>,
        threshold: u8,
        epoch_fee_bps: u16,
    ) -> Result<()> {
        require!(
            !members.is_empty() && members.len() <= MAX_MEMBERS,
            CouncilError::InvalidMemberCount
        );
        for (i, member) in members.iter().enumerate() {
            require!(!members[..i].contains(member), CouncilError::DuplicateMember);
        }
        // threshold must be at least a 2/3 supermajority and reachable
        require!(
            (threshold as usize) <= members.len()
                && (threshold as usize) * 3 >= members.len() * 2,
            CouncilError::InvalidThreshold
        );
        require!(epoch_fee_bps <= BPS_DENOMINATOR, CouncilError::InvalidFee);

        let council_key = ctx.accounts.council.key();
        let member_count = members.len() as u8;

        let council = &mut ctx.accounts.council;
        council.creator = ctx.accounts.creator.key();
        council.members = members;
        council.threshold = threshold;
        council.proposal_count = 0;
        council.bump = ctx.bumps.council;

        let pool = &mut ctx.accounts.pool;
        pool.manager = council_key;
        pool.epoch_fee_bps = epoch_fee_bps;
        pool.allocations = Vec::new();
        pool.bump = ctx.bumps.pool;

        emit!(CouncilCreated {
            council: council_key,
            pool: pool.key(),
            member_count,
            threshold,
        });
        Ok(())
    }

    /// A council member proposes a managerial action. The proposer's approval is counted.
    pub fn propose(ctx: Context<Propose>, action: Action) -> Result<()> {
        action.validate()?;

        let proposer = ctx.accounts.proposer.key();
        let council_key = ctx.accounts.council.key();
        let proposal_key = ctx.accounts.proposal.key();
        let index = ctx.accounts.council.member_index(&proposer)?;
        let id = ctx.accounts.council.proposal_count;

        let proposal = &mut ctx.accounts.proposal;
        proposal.council = council_key;
        proposal.id = id;
        proposal.proposer = proposer;
        proposal.action = action;
        proposal.approvals = 1u16 << index;
        proposal.executed = false;
        proposal.bump = ctx.bumps.proposal;

        let council = &mut ctx.accounts.council;
        council.proposal_count = id.checked_add(1).ok_or(CouncilError::Overflow)?;

        emit!(ProposalCreated {
            council: council_key,
            proposal: proposal_key,
            id,
            proposer,
        });
        Ok(())
    }

    /// A different council member approves an open proposal.
    pub fn approve(ctx: Context<Approve>) -> Result<()> {
        let member = ctx.accounts.member.key();
        let index = ctx.accounts.council.member_index(&member)?;
        let threshold = ctx.accounts.council.threshold;
        let proposal_key = ctx.accounts.proposal.key();

        let proposal = &mut ctx.accounts.proposal;
        require!(!proposal.executed, CouncilError::AlreadyExecuted);
        let bit = 1u16 << index;
        require!((proposal.approvals & bit) == 0, CouncilError::AlreadyApproved);
        proposal.approvals |= bit;

        emit!(ProposalApproved {
            proposal: proposal_key,
            member,
            approvals: proposal.approvals.count_ones() as u8,
            threshold,
        });
        Ok(())
    }

    /// Anyone can crank execution once the approval threshold is met.
    /// The council PDA is the pool manager, so this is the only path that can change the pool.
    pub fn execute(ctx: Context<Execute>) -> Result<()> {
        let threshold = ctx.accounts.council.threshold as u32;
        let proposal_key = ctx.accounts.proposal.key();
        let executor = ctx.accounts.executor.key();

        let proposal = &mut ctx.accounts.proposal;
        let pool = &mut ctx.accounts.pool;

        require!(!proposal.executed, CouncilError::AlreadyExecuted);
        require!(
            proposal.approvals.count_ones() >= threshold,
            CouncilError::ThresholdNotMet
        );

        match &proposal.action {
            Action::SetFee { fee_bps } => {
                pool.epoch_fee_bps = *fee_bps;
            }
            Action::SetStakeDistribution { allocations } => {
                pool.allocations = allocations.clone();
            }
        }
        proposal.executed = true;

        emit!(ProposalExecuted {
            proposal: proposal_key,
            id: proposal.id,
            executor,
        });
        Ok(())
    }
}

// ---------------------------------------------------------------- accounts

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(
        init,
        payer = creator,
        space = 8 + Council::INIT_SPACE,
        seeds = [b"council", creator.key().as_ref()],
        bump
    )]
    pub council: Account<'info, Council>,
    #[account(
        init,
        payer = creator,
        space = 8 + PoolConfig::INIT_SPACE,
        seeds = [b"pool", council.key().as_ref()],
        bump
    )]
    pub pool: Account<'info, PoolConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Propose<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub proposer: Signer<'info>,
    #[account(mut)]
    pub council: Account<'info, Council>,
    #[account(
        init,
        payer = payer,
        space = Proposal::SPACE,
        seeds = [
            b"proposal",
            council.key().as_ref(),
            council.proposal_count.to_le_bytes().as_ref()
        ],
        bump
    )]
    pub proposal: Account<'info, Proposal>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Approve<'info> {
    pub member: Signer<'info>,
    pub council: Account<'info, Council>,
    #[account(mut, has_one = council @ CouncilError::WrongCouncil)]
    pub proposal: Account<'info, Proposal>,
}

#[derive(Accounts)]
pub struct Execute<'info> {
    pub executor: Signer<'info>,
    pub council: Account<'info, Council>,
    #[account(mut, has_one = council @ CouncilError::WrongCouncil)]
    pub proposal: Account<'info, Proposal>,
    #[account(
        mut,
        constraint = pool.manager == council.key() @ CouncilError::NotPoolManager
    )]
    pub pool: Account<'info, PoolConfig>,
}

// ------------------------------------------------------------------- state

#[account]
#[derive(InitSpace)]
pub struct Council {
    pub creator: Pubkey,
    #[max_len(MAX_MEMBERS)]
    pub members: Vec<Pubkey>,
    pub threshold: u8,
    pub proposal_count: u64,
    pub bump: u8,
}

impl Council {
    pub fn member_index(&self, key: &Pubkey) -> Result<usize> {
        self.members
            .iter()
            .position(|member| member == key)
            .ok_or_else(|| error!(CouncilError::NotAMember))
    }
}

/// The managed stake pool settings. `manager` is the council PDA — no private key exists for it.
#[account]
#[derive(InitSpace)]
pub struct PoolConfig {
    pub manager: Pubkey,
    pub epoch_fee_bps: u16,
    #[max_len(MAX_VALIDATORS)]
    pub allocations: Vec<Allocation>,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq, InitSpace)]
pub struct Allocation {
    pub validator: Pubkey,
    pub weight_bps: u16,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub enum Action {
    SetFee { fee_bps: u16 },
    SetStakeDistribution { allocations: Vec<Allocation> },
}

impl Action {
    /// enum tag + vec length prefix + the largest allocation list
    pub const MAX_SPACE: usize = 1 + 4 + MAX_VALIDATORS * (32 + 2);

    pub fn validate(&self) -> Result<()> {
        match self {
            Action::SetFee { fee_bps } => {
                require!(*fee_bps <= BPS_DENOMINATOR, CouncilError::InvalidFee);
            }
            Action::SetStakeDistribution { allocations } => {
                require!(
                    !allocations.is_empty() && allocations.len() <= MAX_VALIDATORS,
                    CouncilError::InvalidDistribution
                );
                let mut total: u32 = 0;
                for (i, allocation) in allocations.iter().enumerate() {
                    require!(
                        !allocations[..i]
                            .iter()
                            .any(|other| other.validator == allocation.validator),
                        CouncilError::InvalidDistribution
                    );
                    total = total
                        .checked_add(allocation.weight_bps as u32)
                        .ok_or(CouncilError::Overflow)?;
                }
                require!(
                    total == BPS_DENOMINATOR as u32,
                    CouncilError::InvalidDistribution
                );
            }
        }
        Ok(())
    }
}

#[account]
pub struct Proposal {
    pub council: Pubkey,
    pub id: u64,
    pub proposer: Pubkey,
    pub action: Action,
    /// bitmap: bit i set = council.members[i] approved
    pub approvals: u16,
    pub executed: bool,
    pub bump: u8,
}

impl Proposal {
    pub const SPACE: usize = 8 + 32 + 8 + 32 + Action::MAX_SPACE + 2 + 1 + 1;
}

// ------------------------------------------------------------------ events

#[event]
pub struct CouncilCreated {
    pub council: Pubkey,
    pub pool: Pubkey,
    pub member_count: u8,
    pub threshold: u8,
}

#[event]
pub struct ProposalCreated {
    pub council: Pubkey,
    pub proposal: Pubkey,
    pub id: u64,
    pub proposer: Pubkey,
}

#[event]
pub struct ProposalApproved {
    pub proposal: Pubkey,
    pub member: Pubkey,
    pub approvals: u8,
    pub threshold: u8,
}

#[event]
pub struct ProposalExecuted {
    pub proposal: Pubkey,
    pub id: u64,
    pub executor: Pubkey,
}

// ------------------------------------------------------------------ errors

#[error_code]
pub enum CouncilError {
    #[msg("Council needs between 1 and 10 members")]
    InvalidMemberCount,
    #[msg("Duplicate council member")]
    DuplicateMember,
    #[msg("Threshold must be a 2/3 supermajority and no larger than the member count")]
    InvalidThreshold,
    #[msg("Signer is not a council member")]
    NotAMember,
    #[msg("This member already approved the proposal")]
    AlreadyApproved,
    #[msg("Proposal was already executed")]
    AlreadyExecuted,
    #[msg("Not enough approvals to execute")]
    ThresholdNotMet,
    #[msg("Fee must be at most 10000 bps")]
    InvalidFee,
    #[msg("Stake distribution needs unique validators whose weights sum to 10000 bps")]
    InvalidDistribution,
    #[msg("Proposal belongs to a different council")]
    WrongCouncil,
    #[msg("Pool is not managed by this council")]
    NotPoolManager,
    #[msg("Arithmetic overflow")]
    Overflow,
}
