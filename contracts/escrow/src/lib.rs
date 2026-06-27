#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, token, Address, BytesN, Env, Symbol};

mod test;

/// Semantic version of this contract. Bumped on every upgrade.
pub const CONTRACT_VERSION: u32 = 1;

#[derive(Clone)]
#[contracttype]
pub struct EscrowCreated {
    pub escrow_id: u64,
    pub sender: Address,
    pub recipient: Address,
    pub agent: Address,
    pub amount: i128,
    pub release_fee_bps: u32,
}

#[derive(Clone)]
#[contracttype]
pub struct EscrowReleased {
    pub escrow_id: u64,
    pub agent_amount: i128,
    pub fee_amount: i128,
}

#[derive(Clone)]
#[contracttype]
pub struct EscrowPartiallyReleased {
    pub escrow_id: u64,
    pub released_amount: i128,
    pub agent_amount: i128,
    pub fee_amount: i128,
    pub remaining_amount: i128,
}

#[derive(Clone)]
#[contracttype]
pub struct EscrowCancelled {
    pub escrow_id: u64,
    pub refund_amount: i128,
}

#[derive(Clone)]
#[contracttype]
pub struct DeliveryConfirmed {
    pub escrow_id: u64,
    pub agent: Address,
}

#[derive(Clone)]
#[contracttype]
pub struct PartialRelease {
    pub escrow_id: u64,
    pub released_amount: i128,
    pub remaining_amount: i128,
    pub fee_amount: i128,
}

#[derive(Clone)]
#[contracttype]
pub struct EscrowArchived {
    pub escrow_id: u64,
}

#[derive(Clone)]
#[contracttype]
pub struct Upgraded {
    pub new_wasm_hash: BytesN<32>,
    pub contract_version: u32,
}

#[derive(Clone, Debug)]
#[contracttype]
pub struct FeesWithdrawn {
    pub admin: Address,
    pub amount: i128,
}

#[derive(Clone)]
#[contracttype]
pub struct FeeUpdated {
    pub escrow_id: u64,
    pub old_fee_bps: u32,
    pub new_fee_bps: u32,
}

#[derive(Clone)]
#[contracttype]
pub struct EscrowDeposited {
    pub escrow_id: u64,
    pub depositor: Address,
    pub amount: i128,
    pub new_total: i128,
}

#[derive(Clone)]
#[contracttype]
pub struct Escrow {
    pub id: u64,
    pub sender: Address,
    pub recipient: Address,
    pub agent: Address,
    pub amount: i128,
    pub release_fee_bps: u32,
    pub status: EscrowStatus,
    pub payout_confirmed: bool,
    pub created_at: u64,
    pub updated_at: u64,
    pub expires_at: u64,
}

#[derive(Clone, Copy, PartialEq, Eq)]
#[contracttype]
pub enum EscrowStatus {
    Pending,
    Released,
    Cancelled,
}

#[contracttype]
pub enum DataKey {
    Admin,
    UsdcAddress,
    EscrowCounter,
    AccumulatedFees,
    RetentionPeriodSecs,
    Escrow(u64),
}

const DEFAULT_EXPIRY_SECS: u64 = 30 * 24 * 60 * 60;
const DEFAULT_RETENTION_SECS: u64 = 90 * 24 * 60 * 60;

/// Maximum allowed fee: 50% (5000 bps). Configurable by admin via contract upgrade.
const MAX_FEE_BPS: u32 = 5000;

/// Minimum escrow amount in stroops to prevent integer-division rounding to zero fee.
const MIN_ESCROW_AMOUNT: i128 = 100;

fn require_admin(env: &Env, admin: &Address) {
    admin.require_auth();
    let stored_admin: Address = env
        .storage()
        .persistent()
        .get(&DataKey::Admin)
        .expect("Contract not initialized");
    if admin != &stored_admin {
        panic!("Only admin can perform this action");
    }
}

fn retention_period(env: &Env) -> u64 {
    env.storage()
        .persistent()
        .get(&DataKey::RetentionPeriodSecs)
        .unwrap_or(DEFAULT_RETENTION_SECS)
}

#[contract]
pub struct EscrowContract;

#[contractimpl]
impl EscrowContract {
    /// Initialize the escrow contract.
    ///
    /// SECURITY — front-running prevention (#336):
    /// This function must be called in the same transaction as deployment, or
    /// immediately after deployment with no manual steps in between. The deploy
    /// script (`contracts/deploy.sh`) handles this automatically.
    ///
    /// Re-initialization is permanently blocked by the `has(Admin)` guard.
    /// There is no mechanism to change the admin after initialization.
    pub fn initialize(env: Env, admin: Address, usdc_address: Address) {
        if env.storage().persistent().has(&DataKey::Admin) {
            panic!("Contract already initialized");
        }
        env.storage().persistent().set(&DataKey::Admin, &admin);
        env.storage().persistent().set(&DataKey::UsdcAddress, &usdc_address);
        env.storage().persistent().set(&DataKey::EscrowCounter, &0u64);
        env.events().publish(
            (Symbol::new(&env, "EscrowInitialized"),),
            (env.current_contract_address(), admin, usdc_address),
        );
    }

    /// Upgrade the contract WASM. Only the admin may call this.
    ///
    /// # Irreversibility
    /// Contract upgrades are **irreversible on-chain**. Once a new WASM hash is
    /// applied, the previous bytecode cannot be restored. Always test on testnet
    /// before upgrading mainnet deployments.
    pub fn upgrade(env: Env, admin: Address, new_wasm_hash: BytesN<32>) {
        admin.require_auth();

        let stored_admin: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("Contract not initialized");

        if admin != stored_admin {
            panic!("Only admin can upgrade the contract");
        }

        env.deployer().update_current_contract_wasm(new_wasm_hash.clone());

        env.events().publish(
            (Symbol::new(&env, "Upgraded"),),
            Upgraded {
                new_wasm_hash,
                contract_version: CONTRACT_VERSION,
            },
        );
    }

    pub fn create_escrow(
        env: Env,
        sender: Address,
        recipient: Address,
        agent: Address,
        amount: i128,
        release_fee_bps: u32,
    ) -> u64 {
        if amount < MIN_ESCROW_AMOUNT {
            panic!("Amount below minimum (100 stroops)");
        }
        if release_fee_bps == 10000 {
            panic!("Fee cannot be 100%");
        }
        if release_fee_bps > MAX_FEE_BPS {
            panic!("Fee exceeds maximum of 5000 bps (50%)");
        }
        if sender == recipient || sender == agent || recipient == agent {
            panic!("Sender, recipient, and agent must be distinct addresses");
        }

        sender.require_auth();

        let usdc_address: Address = env
            .storage()
            .persistent()
            .get(&DataKey::UsdcAddress)
            .expect("Contract not initialized");

        token::Client::new(&env, &usdc_address).transfer(
            &sender,
            &env.current_contract_address(),
            &amount,
        );

        let current_id: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::EscrowCounter)
            .unwrap_or(0);
        // u64::MAX is 18,446,744,073,709,551,615. At one escrow per second,
        // exhausting the counter would take ~584 billion years.
        let next_id = current_id.checked_add(1).expect("Escrow counter overflow");
        env.storage()
            .persistent()
            .set(&DataKey::EscrowCounter, &next_id);

        let now = env.ledger().timestamp();
        let escrow = Escrow {
            id: next_id,
            sender: sender.clone(),
            recipient: recipient.clone(),
            agent: agent.clone(),
            amount,
            release_fee_bps,
            status: EscrowStatus::Pending,
            payout_confirmed: false,
            created_at: now,
            updated_at: now,
            expires_at: now + DEFAULT_EXPIRY_SECS,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(next_id), &escrow);

        env.events().publish(
            (Symbol::new(&env, "EscrowCreated"),),
            EscrowCreated {
                escrow_id: next_id,
                sender,
                recipient,
                agent,
                amount,
                release_fee_bps,
            },
        );

        next_id
    }

    pub fn deposit(env: Env, sender: Address, escrow_id: u64, amount: i128) {
        if amount <= 0 {
            panic!("Amount must be positive");
        }

        sender.require_auth();

        let mut escrow: Escrow = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .unwrap_or_else(|| panic!("Escrow {} not found", escrow_id));

        if escrow.status != EscrowStatus::Pending {
            panic!("Escrow is not in pending state");
        }

        if env.ledger().timestamp() >= escrow.expires_at {
            panic!("Escrow has expired");
        }

        let usdc_address: Address = env
            .storage()
            .persistent()
            .get(&DataKey::UsdcAddress)
            .expect("Contract not initialized");

        token::Client::new(&env, &usdc_address).transfer(
            &sender,
            &env.current_contract_address(),
            &amount,
        );

        escrow.amount += amount;
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &escrow);

        env.events().publish(
            (Symbol::new(&env, "EscrowDeposited"),),
            EscrowDeposited {
                escrow_id,
                depositor: sender,
                amount,
                new_total: escrow.amount,
            },
        );
    }

    pub fn release_escrow(env: Env, agent: Address, escrow_id: u64) {
        agent.require_auth();

        let mut escrow: Escrow = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .unwrap_or_else(|| panic!("Escrow {} not found", escrow_id));

        if agent != escrow.agent {
            panic!("Only the agent can release escrow");
        }
        if escrow.status != EscrowStatus::Pending {
            panic!("Escrow is not in pending state");
        }
        // Expiry guard: expired escrows must be cancelled by the sender via
        // cancel_escrow — the agent cannot release funds after the protection window.
        if env.ledger().timestamp() >= escrow.expires_at {
            panic!("Escrow has expired");
        }

        let fee_amount = (escrow.amount * escrow.release_fee_bps as i128) / 10000;
        let agent_amount = escrow.amount - fee_amount;

        let usdc_address: Address = env
            .storage()
            .persistent()
            .get(&DataKey::UsdcAddress)
            .expect("Contract not initialized");

        token::Client::new(&env, &usdc_address).transfer(
            &env.current_contract_address(),
            &escrow.agent,
            &agent_amount,
        );

        let current_fees: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::AccumulatedFees)
            .unwrap_or(0);
        env.storage()
            .persistent()
            .set(&DataKey::AccumulatedFees, &(current_fees + fee_amount));

        escrow.status = EscrowStatus::Released;
        escrow.updated_at = env.ledger().timestamp();
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &escrow);

        env.events().publish(
            (Symbol::new(&env, "EscrowReleased"),),
            EscrowReleased {
                escrow_id,
                agent_amount,
                fee_amount,
            },
        );
    }

    pub fn confirm_delivery(env: Env, agent: Address, escrow_id: u64) {
        agent.require_auth();

        let mut escrow: Escrow = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .unwrap_or_else(|| panic!("Escrow {} not found", escrow_id));

        if agent != escrow.agent {
            panic!("Only the agent can confirm delivery");
        }
        if escrow.status != EscrowStatus::Pending {
            panic!("Escrow is not in pending state");
        }
        if escrow.payout_confirmed {
            panic!("Delivery has already been confirmed");
        }

        escrow.payout_confirmed = true;
        escrow.updated_at = env.ledger().timestamp();
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &escrow);

        env.events().publish(
            (Symbol::new(&env, "DeliveryConfirmed"),),
            DeliveryConfirmed {
                escrow_id,
                agent,
            },
        );
    }

    pub fn partial_release(env: Env, agent: Address, escrow_id: u64, amount: i128) {
        agent.require_auth();

        if amount <= 0 {
            panic!("Amount must be positive");
        }

        let mut escrow: Escrow = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .unwrap_or_else(|| panic!("Escrow {} not found", escrow_id));

        if agent != escrow.agent {
            panic!("Only the agent can release escrow");
        }
        if escrow.status != EscrowStatus::Pending {
            panic!("Escrow is not in pending state");
        }
        if amount > escrow.amount {
            panic!("Release amount exceeds escrow balance");
        }

        let fee_amount = (amount * escrow.release_fee_bps as i128) / 10000;
        let agent_amount = amount - fee_amount;

        let usdc_address: Address = env
            .storage()
            .persistent()
            .get(&DataKey::UsdcAddress)
            .expect("Contract not initialized");

        token::Client::new(&env, &usdc_address).transfer(
            &env.current_contract_address(),
            &escrow.agent,
            &agent_amount,
        );

        let current_fees: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::AccumulatedFees)
            .unwrap_or(0);
        env.storage()
            .persistent()
            .set(&DataKey::AccumulatedFees, &(current_fees + fee_amount));

        escrow.amount -= amount;
        if escrow.amount == 0 {
            escrow.status = EscrowStatus::Released;
        }
        escrow.updated_at = env.ledger().timestamp();
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &escrow);

        env.events().publish(
            (Symbol::new(&env, "PartialRelease"),),
            PartialRelease {
                escrow_id,
                released_amount: amount,
                remaining_amount: escrow.amount,
                fee_amount,
            },
        );
    }

    pub fn set_retention_period(env: Env, admin: Address, retention_secs: u64) {
        require_admin(&env, &admin);
        if retention_secs == 0 {
            panic!("Retention period must be positive");
        }
        env.storage()
            .persistent()
            .set(&DataKey::RetentionPeriodSecs, &retention_secs);
    }

    pub fn cleanup_escrow(env: Env, admin: Address, escrow_id: u64) {
        require_admin(&env, &admin);

        let escrow: Escrow = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .unwrap_or_else(|| panic!("Escrow {} not found", escrow_id));

        if escrow.status != EscrowStatus::Released && escrow.status != EscrowStatus::Cancelled {
            panic!("Only released or cancelled escrows can be cleaned up");
        }

        let retention = retention_period(&env);
        let now = env.ledger().timestamp();
        if now < escrow.updated_at + retention {
            panic!("Escrow retention period has not elapsed");
        }

        env.storage().persistent().remove(&DataKey::Escrow(escrow_id));

        env.events().publish(
            (Symbol::new(&env, "EscrowArchived"),),
            EscrowArchived { escrow_id },
        );
    }

    pub fn cancel_escrow(env: Env, sender: Address, escrow_id: u64) {
        sender.require_auth();

        let mut escrow: Escrow = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .unwrap_or_else(|| panic!("Escrow {} not found", escrow_id));

        if sender != escrow.sender {
            panic!("Only the sender can cancel escrow");
        }
        if escrow.status != EscrowStatus::Pending {
            panic!("Escrow is not in pending state");
        }
        if escrow.payout_confirmed {
            panic!("Cannot cancel: agent has confirmed delivery");
        }

        let usdc_address: Address = env
            .storage()
            .persistent()
            .get(&DataKey::UsdcAddress)
            .expect("Contract not initialized");

        token::Client::new(&env, &usdc_address).transfer(
            &env.current_contract_address(),
            &escrow.sender,
            &escrow.amount,
        );

        escrow.status = EscrowStatus::Cancelled;
        escrow.updated_at = env.ledger().timestamp();
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &escrow);

        env.events().publish(
            (Symbol::new(&env, "EscrowCancelled"),),
            EscrowCancelled {
                escrow_id,
                refund_amount: escrow.amount,
            },
        );
    }

    /// Permissionless auto-refund triggered by anyone once the escrow expiry timestamp
    /// has passed. Refunds the full remaining balance to the original sender.
    pub fn expire_escrow(env: Env, escrow_id: u64) {
        let mut escrow: Escrow = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .unwrap_or_else(|| panic!("Escrow {} not found", escrow_id));

        if escrow.status != EscrowStatus::Pending {
            panic!("Escrow is not in pending state");
        }

        let now = env.ledger().timestamp();
        if now < escrow.expires_at {
            panic!("Escrow has not expired yet");
        }

        let usdc_address: Address = env
            .storage()
            .persistent()
            .get(&DataKey::UsdcAddress)
            .expect("Contract not initialized");

        token::Client::new(&env, &usdc_address).transfer(
            &env.current_contract_address(),
            &escrow.sender,
            &escrow.amount,
        );

        escrow.status = EscrowStatus::Cancelled;
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &escrow);

        env.events().publish(
            (Symbol::new(&env, "EscrowExpired"),),
            EscrowExpired {
                escrow_id,
                refund_amount: escrow.amount,
                expired_at: now,
            },
        );
    }

    pub fn get_escrow(env: Env, escrow_id: u64) -> Escrow {
        env.storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .unwrap_or_else(|| panic!("Escrow {} not found", escrow_id))
    }

    pub fn get_accumulated_fees(env: Env) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::AccumulatedFees)
            .unwrap_or(0)
    }

    pub fn withdraw_fees(env: Env, admin: Address, amount: i128) {
        admin.require_auth();

        if amount <= 0 {
            panic!("Amount must be positive");
        }

        let stored_admin: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("Contract not initialized");

        if admin != stored_admin {
            panic!("Only admin can withdraw fees");
        }

        let current_fees: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::AccumulatedFees)
            .unwrap_or(0);

        if amount > current_fees {
            panic!("Insufficient accumulated fees");
        }

        let usdc_address: Address = env
            .storage()
            .persistent()
            .get(&DataKey::UsdcAddress)
            .expect("Contract not initialized");

        token::Client::new(&env, &usdc_address).transfer(
            &env.current_contract_address(),
            &admin,
            &amount,
        );

        env.storage()
            .persistent()
            .set(&DataKey::AccumulatedFees, &(current_fees - amount));

        env.events().publish(
            (Symbol::new(&env, "FeesWithdrawn"),),
            FeesWithdrawn {
                admin: admin.clone(),
                amount,
            },
        );
    }

    /// Update the fee for an escrow. Only the contract admin can call this.
    ///
    /// The escrow must be in Pending status. Emits a FeeUpdated event with the
    /// old and new fee values.
    ///
    /// # Arguments
    /// * `admin`       — Must match the admin set during `initialize`.
    /// * `escrow_id`   — ID of the escrow to update.
    /// * `new_fee_bps` — New fee in basis points (0–5000).
    pub fn update_fee(env: Env, admin: Address, escrow_id: u64, new_fee_bps: u32) {
        admin.require_auth();

        let stored_admin: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("Contract not initialized");

        if admin != stored_admin {
            panic!("Only admin can update escrow fees");
        }

        if new_fee_bps > MAX_FEE_BPS {
            panic!("New fee exceeds maximum of 5000 bps (50%)");
        }

        let mut escrow: Escrow = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .unwrap_or_else(|| panic!("Escrow {} not found", escrow_id));

        if escrow.status != EscrowStatus::Pending {
            panic!("Escrow is not in pending state");
        }

        let old_fee_bps = escrow.release_fee_bps;
        escrow.release_fee_bps = new_fee_bps;
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), &escrow);

        env.events().publish(
            (Symbol::new(&env, "FeeUpdated"),),
            FeeUpdated {
                escrow_id,
                old_fee_bps,
                new_fee_bps,
            },
        );
    }

    pub fn get_metadata(env: Env) -> (Address, Address) {
        let admin: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("Contract not initialized");
        let usdc_address: Address = env
            .storage()
            .persistent()
            .get(&DataKey::UsdcAddress)
            .expect("Contract not initialized");
        (admin, usdc_address)
    }
}
