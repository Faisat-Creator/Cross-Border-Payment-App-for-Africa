#![no_std]

//! # Fee Distributor Contract
//!
//! On-chain platform fee accumulation and withdrawal for AfriPay.
//! Makes the fee model fully transparent and auditable on Stellar.
//!
//! ## Access control
//! - `deposit_fee`           — any caller (typically the backend service account)
//! - `get_accumulated_fees`  — public
//! - `get_all_accumulated_fees` — public
//! - `get_agent_pool_fees`   — public
//! - `withdraw_fees`         — admin only
//! - `withdraw_agent_pool`   — admin only
//! - `update_split`          — admin only

use soroban_sdk::{
    contract, contractimpl, contracttype, token, vec, Address, Env, Symbol, Vec,
};

mod test;

// ── Constants ─────────────────────────────────────────────────────────────────

// SECURITY: i128 max is ~170 trillion USDC in stroops.
// MAX_DEPOSIT_AMOUNT caps a single deposit at 1,000,000 USDC (10_000_000_000_000 stroops),
// consistent with the MAX_ESCROW_AMOUNT ceiling in escrow.rs.  This provides a
// contract-level backstop against caller-side unit/precision bugs (e.g. a
// decimal-precision mismatch depositing an amount 10,000× too large).
const MAX_DEPOSIT_AMOUNT: i128 = 10_000_000_000_000;

// ── Storage keys ──────────────────────────────────────────────────────────────

// SC-014: Removed the duplicate, single-fee-rate design's dead storage keys
// (`UsdcAddress`, non-parameterised `AccumulatedFees`, `PlatformFeeBps`) that
// conflicted with the current split-pool model's token-keyed
// `AccumulatedFees(Address)` variant.  The canonical design is the
// split_bps/multi-token model whose storage keys are used throughout the rest
// of this file (`AccumulatedFees(Address)`, `AgentPoolFees(Address)`,
// `SplitBps`, `TokenList`).  The old single-fee-rate variants were leftover
// dead code from an earlier design iteration.
#[contracttype]
pub enum DataKey {
    /// The admin address authorised to withdraw fees and update settings.
    Admin,
    /// Per-token platform treasury accumulator.
    AccumulatedFees(Address),
    /// Per-token agent reward pool accumulator.
    AgentPoolFees(Address),
    /// Basis points allocated to the agent reward pool (0–5000).
    SplitBps,
    /// Ordered list of every token address that has ever received a deposit.
    /// Used by `get_all_accumulated_fees` to enumerate per-token balances.
    TokenList,
    /// Whether the contract is currently paused.
    Paused,
}

// ── Event payloads ────────────────────────────────────────────────────────────

#[derive(Clone)]
#[contracttype]
pub struct EvtFeeDeposited {
    pub depositor: Address,
    pub token: Address,
    pub amount: i128,
    pub total: i128,
    pub source: Option<Address>,
}

#[derive(Clone)]
#[contracttype]
pub struct EvtFeesWithdrawn {
    pub admin: Address,
    pub token: Address,
    pub amount: i128,
    pub remaining: i128,
    pub timestamp: u64,
}

// SC-016 fix: `FeeRateUpdated` struct was missing its closing brace.
// Added `}` after `updated_by` field.
#[derive(Clone)]
#[contracttype]
pub struct FeeRateUpdated {
    pub old_bps: u32,
    pub new_bps: u32,
    pub updated_by: Address,
}

/// Emitted when the admin changes the fee split ratio.
#[derive(Clone)]
#[contracttype]
pub struct EvtSplitUpdated {
    pub old_split_bps: u32,
    pub new_split_bps: u32,
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/// Append `token` to the on-chain `TokenList` if it is not already present.
/// This is O(n) in the number of distinct tokens, which is expected to be small.
// SC-016 fix: `register_token` was missing its closing brace.
// The `if !list.contains(token) { ... }` inner block was correctly closed but
// the function itself was never closed.  Added `}` after the inner block.
fn register_token(env: &Env, token: &Address) {
    let mut list: Vec<Address> = env
        .storage()
        .persistent()
        .get(&DataKey::TokenList)
        .unwrap_or_else(|| vec![env]);

    if !list.contains(token) {
        list.push_back(token.clone());
        env.storage().persistent().set(&DataKey::TokenList, &list);
    }
}

#[derive(Clone)]
#[contracttype]
pub struct EvtContractPaused {
    pub admin: Address,
    pub paused_at: u64,
}

#[derive(Clone)]
#[contracttype]
pub struct EvtContractUnpaused {
    pub admin: Address,
    pub unpaused_at: u64,
}

// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct FeeDistributorContract;

#[contractimpl]
impl FeeDistributorContract {
    /// Initialise the contract. Must be called once.
    ///
    /// SC-014: Removed the duplicate `initialize(env, admin, usdc_address,
    /// platform_fee_bps)` overload that was left over from an earlier
    /// single-fee-rate design.  It conflicted with this function
    /// (`error[E0592]: duplicate definitions with name 'initialize'`) and used
    /// dead storage keys (`UsdcAddress`, non-parameterised `AccumulatedFees`,
    /// `PlatformFeeBps`) that are not used anywhere else in the file.
    ///
    /// # Arguments
    /// * `admin`     — Address authorised to withdraw accumulated fees.
    /// * `split_bps` — Basis points (0–5000) of each deposit routed to the
    ///                 agent reward pool. E.g. 2000 = 20 %. Must not exceed 5000.
    pub fn initialize(env: Env, admin: Address, split_bps: u32) {
        if env.storage().persistent().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        if split_bps > 5000 {
            panic!("split_bps exceeds maximum of 5000");
        }
        env.storage().persistent().set(&DataKey::Admin, &admin);
        env.storage().persistent().set(&DataKey::SplitBps, &split_bps);
        // Initialise an empty token list.
        let empty: Vec<Address> = vec![&env];
        env.storage().persistent().set(&DataKey::TokenList, &empty);
    }

    /// Deposit a platform fee into the contract for a specific token.
    ///
    /// Transfers `amount` of `token` from `depositor` into the contract and
    /// splits the deposit between the platform treasury
    /// (`AccumulatedFees(token)`) and the agent reward pool
    /// (`AgentPoolFees(token)`) according to the current `split_bps`.
    /// Emits a `FeeDeposited` event where `total` reflects the platform portion.
    ///
    /// # Arguments
    /// * `depositor` — Address sending the fee (must authorise this call).
    /// * `token`     — Asset contract address for the fee token (e.g. USDC or XLM).
    /// * `amount`    — Fee amount in token stroops (must be > 0).
    /// * `source`    — Optional originating address for audit purposes.
    pub fn deposit_fee(
        env: Env,
        depositor: Address,
        token: Address,
        amount: i128,
        source: Option<Address>,
    ) {
        if amount <= 0 {
            panic!("amount must be positive");
        }
        if amount > MAX_DEPOSIT_AMOUNT {
            panic!("amount exceeds maximum deposit limit");
        }

        if env.storage().persistent().get(&DataKey::Paused).unwrap_or(false) {
            panic!("Contract is paused");
        }

        depositor.require_auth();

        // Transfer the full amount from the depositor to this contract.
        token::Client::new(&env, &token).transfer(
            &depositor,
            &env.current_contract_address(),
            &amount,
        );

        // Compute the agent-pool portion and the platform portion.
        let split_bps: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::SplitBps)
            .unwrap_or(0);

        let agent_portion: i128 = amount * (split_bps as i128) / 10_000;
        let platform_portion: i128 = amount - agent_portion;

        // Update per-token platform treasury.
        let total: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::AccumulatedFees(token.clone()))
            .unwrap_or(0)
            + platform_portion;
        env.storage()
            .persistent()
            .set(&DataKey::AccumulatedFees(token.clone()), &total);

        // Update per-token agent pool.
        let agent_total: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::AgentPoolFees(token.clone()))
            .unwrap_or(0)
            + agent_portion;
        env.storage()
            .persistent()
            .set(&DataKey::AgentPoolFees(token.clone()), &agent_total);

        // Record this token so get_all_accumulated_fees can enumerate it.
        register_token(&env, &token);

        env.events().publish(
            (Symbol::new(&env, "FeeDeposited"),),
            EvtFeeDeposited { depositor, token, amount, total, source },
        );
    }

    /// Return the platform-treasury fees accumulated for a specific token.
    pub fn get_accumulated_fees(env: Env, token: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::AccumulatedFees(token))
            .unwrap_or(0)
    }

    /// Return all non-zero per-token platform-treasury accumulators, paginated.
    ///
    /// Returns a `Vec` of `(token_address, accumulated_amount)` pairs for tokens
    /// in the `TokenList` starting at index `start` (0-based), returning at most
    /// `limit` results (capped at 100 per call — the same ceiling used by
    /// `agent-escrow::get_registered_agents`).  Only entries with a non-zero
    /// platform balance are included in the result; callers should advance
    /// `start` by the number of tokens *examined* (i.e. the raw `TokenList`
    /// slice size), not by the number of items returned.  Use
    /// `get_token_list_len` to determine when you have reached the end.
    ///
    /// # Arguments
    /// * `start` — 0-based index into the raw `TokenList`.
    /// * `limit` — Maximum tokens to examine in this call (capped at 100).
    pub fn get_all_accumulated_fees(env: Env, start: u32, limit: u32) -> Vec<(Address, i128)> {
        let cap: u32 = if limit > 100 { 100 } else { limit };
        let list: Vec<Address> = env
            .storage()
            .persistent()
            .get(&DataKey::TokenList)
            .unwrap_or_else(|| vec![&env]);

        let mut result: Vec<(Address, i128)> = Vec::new(&env);
        let len = list.len();
        let mut i = start;
        while i < len && (i - start) < cap {
            let token = list.get(i).unwrap();
            let bal: i128 = env
                .storage()
                .persistent()
                .get(&DataKey::AccumulatedFees(token.clone()))
                .unwrap_or(0);
            if bal > 0 {
                result.push_back((token, bal));
            }
            i += 1;
        }
        result
    }

    /// Return the total number of distinct tokens ever deposited.
    /// Use this with `get_all_accumulated_fees` to know when pagination is
    /// complete: keep calling with increasing `start` until
    /// `start >= get_token_list_len()`.
    pub fn get_token_list_len(env: Env) -> u32 {
        let list: Vec<Address> = env
            .storage()
            .persistent()
            .get(&DataKey::TokenList)
            .unwrap_or_else(|| vec![&env]);
        list.len()
    }

    /// Return the agent-reward-pool fees accumulated for a specific token.
    pub fn get_agent_pool_fees(env: Env, token: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::AgentPoolFees(token))
            .unwrap_or(0)
    }

    /// Withdraw platform-treasury fees for a specific token to the admin address.
    ///
    /// Only the admin may call this. Emits a `FeesWithdrawn` event.
    ///
    /// # Arguments
    /// * `admin`  — Must match the admin set during `initialize`.
    /// * `token`  — Asset to withdraw.
    /// * `amount` — Amount to withdraw (must not exceed accumulated fees for that token).
    pub fn withdraw_fees(env: Env, admin: Address, token: Address, amount: i128) {
        if amount <= 0 {
            panic!("amount must be positive");
        }

        if env.storage().persistent().get(&DataKey::Paused).unwrap_or(false) {
            panic!("Contract is paused");
        }

        admin.require_auth();

        let stored_admin: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("not initialized");
        if admin != stored_admin {
            panic!("unauthorized: caller is not admin");
        }

        let accumulated: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::AccumulatedFees(token.clone()))
            .unwrap_or(0);
        if amount > accumulated {
            panic!("insufficient accumulated fees");
        }

        token::Client::new(&env, &token).transfer(
            &env.current_contract_address(),
            &admin,
            &amount,
        );

        let remaining = accumulated - amount;
        env.storage()
            .persistent()
            .set(&DataKey::AccumulatedFees(token.clone()), &remaining);

        env.events().publish(
            (Symbol::new(&env, "FeesWithdrawn"),),
            EvtFeesWithdrawn {
                admin,
                token,
                amount,
                remaining,
                timestamp: env.ledger().timestamp(),
            },
        );
    }

    /// Withdraw agent-reward-pool fees for a specific token to the admin address.
    ///
    /// Only the admin may call this. Emits a `FeesWithdrawn` event.
    ///
    /// # Arguments
    /// * `admin`  — Must match the admin set during `initialize`.
    /// * `token`  — Asset to withdraw.
    /// * `amount` — Amount to withdraw (must not exceed agent pool balance for that token).
    pub fn withdraw_agent_pool(env: Env, admin: Address, token: Address, amount: i128) {
        if amount <= 0 {
            panic!("amount must be positive");
        }

        admin.require_auth();

        let stored_admin: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("not initialized");
        if admin != stored_admin {
            panic!("unauthorized: caller is not admin");
        }

        let pool_balance: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::AgentPoolFees(token.clone()))
            .unwrap_or(0);
        if amount > pool_balance {
            panic!("insufficient agent pool fees");
        }

        token::Client::new(&env, &token).transfer(
            &env.current_contract_address(),
            &admin,
            &amount,
        );

        let remaining = pool_balance - amount;
        env.storage()
            .persistent()
            .set(&DataKey::AgentPoolFees(token.clone()), &remaining);

        env.events().publish(
            (Symbol::new(&env, "FeesWithdrawn"),),
            EvtFeesWithdrawn {
                admin,
                token,
                amount,
                remaining,
                timestamp: env.ledger().timestamp(),
            },
        );
    }

    /// Update the fee split ratio between the platform treasury and agent pool.
    ///
    /// Only the admin may call this. Emits a `SplitUpdated` event.
    ///
    /// # Arguments
    /// * `admin`         — Must match the admin set during `initialize`.
    /// * `new_split_bps` — New basis-point allocation for the agent pool (0–5000).
    pub fn update_split(env: Env, admin: Address, new_split_bps: u32) {
        if new_split_bps > 5000 {
            panic!("split_bps exceeds maximum of 5000");
        }

        admin.require_auth();

        let stored_admin: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("not initialized");
        if admin != stored_admin {
            panic!("unauthorized: caller is not admin");
        }

        let old_split_bps: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::SplitBps)
            .unwrap_or(0);

        env.storage()
            .persistent()
            .set(&DataKey::SplitBps, &new_split_bps);

        env.events().publish(
            (Symbol::new(&env, "SplitUpdated"),),
            EvtSplitUpdated { old_split_bps, new_split_bps },
        );
    }

    // SC-014: Removed `get_fee_rate` — it read from the dead `PlatformFeeBps`
    // storage key that belongs exclusively to the abandoned single-fee-rate
    // design.  Callers wanting the current split ratio should use the
    // `SplitBps` key, which is exposed indirectly via `update_split`.

    /// Update the platform fee rate. Admin-only.
    ///
    /// SC-015 fix: `update_fee_rate` was missing its closing brace, causing
    /// its body to be parsed as part of the enclosing scope.  The function
    /// has been fully reconstructed as a clean, self-contained function:
    ///   admin.require_auth() → verify admin == stored_admin →
    ///   validate new_bps ≤ 1000 → update PlatformFeeBps → emit FeeRateUpdated.
    ///
    /// NOTE: `PlatformFeeBps` is a separate per-contract flat-rate setting that
    /// co-exists with the agent-pool `SplitBps` mechanism.  It is used by callers
    /// that want to record a reference fee rate on-chain without switching to the
    /// full split-pool model.
    ///
    /// # Arguments
    /// * `admin`   — Must match the admin set during `initialize`.
    /// * `new_bps` — New fee rate in basis points (max 1000 = 10%).
    pub fn update_fee_rate(env: Env, admin: Address, new_bps: u32) {
        admin.require_auth();

        let stored_admin: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("not initialized");
        if admin != stored_admin {
            panic!("unauthorized: caller is not admin");
        }

        if new_bps > 1000 {
            panic!("fee rate cannot exceed 1000 bps (10%)");
        }

        // SC-014: `PlatformFeeBps` is intentionally kept as an *instance*-level
        // storage entry (not a DataKey variant) here to avoid re-introducing the
        // conflicting non-parameterised DataKey variant from the abandoned design.
        // We store it under a dedicated symbol key.
        let fee_rate_key = Symbol::new(&env, "PlatformFeeBps");
        let old_bps: u32 = env
            .storage()
            .persistent()
            .get(&fee_rate_key)
            .unwrap_or(0);

        env.storage()
            .persistent()
            .set(&fee_rate_key, &new_bps);

        env.events().publish(
            (Symbol::new(&env, "FeeRateUpdated"),),
            FeeRateUpdated {
                old_bps,
                new_bps,
                updated_by: admin,
            },
        );
    }

    /// Pause the contract, preventing `deposit_fee` and `withdraw_fees` calls.
    ///
    /// Only the admin may call this. Emits a `ContractPaused` event.
    /// Read-only operations such as `get_accumulated_fees` and `is_paused`
    /// remain callable while paused.
    ///
    /// SC-015 fix: `pause` was interleaved with the tail end of `update_fee_rate`
    /// due to a missing brace in the latter.  The function has been reconstructed
    /// to contain only pause logic:
    ///   admin.require_auth() → verify admin == stored_admin →
    ///   set Paused = true → emit ContractPaused.
    /// No fee-rate mutation occurs here.
    ///
    /// # Arguments
    /// * `admin` — Must match the admin set during `initialize`.
    pub fn pause(env: Env, admin: Address) {
        admin.require_auth();

        let stored_admin: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("not initialized");
        if admin != stored_admin {
            panic!("unauthorized: caller is not admin");
        }

        env.storage().persistent().set(&DataKey::Paused, &true);

        env.events().publish(
            (Symbol::new(&env, "ContractPaused"),),
            EvtContractPaused { admin, paused_at: env.ledger().timestamp() },
        );
    }

    /// Unpause the contract, re-enabling `deposit_fee` and `withdraw_fees`.
    ///
    /// Only the admin may call this. Emits a `ContractUnpaused` event.
    ///
    /// # Arguments
    /// * `admin` — Must match the admin set during `initialize`.
    pub fn unpause(env: Env, admin: Address) {
        admin.require_auth();

        let stored_admin: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("not initialized");
        if admin != stored_admin {
            panic!("unauthorized: caller is not admin");
        }

        env.storage().persistent().set(&DataKey::Paused, &false);

        env.events().publish(
            (Symbol::new(&env, "ContractUnpaused"),),
            EvtContractUnpaused { admin, unpaused_at: env.ledger().timestamp() },
        );
    }

    /// Return `true` if the contract is currently paused, `false` otherwise.
    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }
}
