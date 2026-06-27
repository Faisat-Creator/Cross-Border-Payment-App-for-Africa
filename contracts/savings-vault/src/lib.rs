#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, token, Address, Env, Symbol};

mod test;

#[derive(Clone)]
#[contracttype]
pub struct DepositEvent {
    pub user: Address,
    pub amount: i128,
    pub unlock_time: u64,
}

#[derive(Clone)]
#[contracttype]
pub struct WithdrawalEvent {
    pub user: Address,
    pub amount: i128,
    pub penalty: i128,
}

#[derive(Clone)]
#[contracttype]
pub struct AccrueInterestEvent {
    pub user: Address,
    pub interest: i128,
    pub new_balance: i128,
}

#[derive(Clone)]
#[contracttype]
pub struct Vault {
    pub balance: i128,
    pub unlock_time: u64,
    pub last_accrue_time: u64,
}

#[contracttype]
pub enum DataKey {
    Admin,
    TokenAddress,
    InterestRateBps,
    Vault(Address),
}

const EARLY_WITHDRAWAL_PENALTY_BPS: u32 = 1000;
const SECONDS_PER_YEAR: u64 = 31_536_000;

#[contract]
pub struct SavingsVaultContract;

#[contractimpl]
impl SavingsVaultContract {
    pub fn initialize(env: Env, admin: Address, token_address: Address) {
        if env.storage().persistent().has(&DataKey::TokenAddress) {
            panic!("Contract already initialized");
        }
        env.storage().persistent().set(&DataKey::Admin, &admin);
        env.storage().persistent().set(&DataKey::TokenAddress, &token_address);
    }

    /// Set the annual interest rate. Only admin may call this.
    pub fn set_interest_rate(env: Env, admin: Address, rate_bps: u32) {
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("Contract not initialized");
        if admin != stored_admin {
            panic!("unauthorized: caller is not admin");
        }
        env.storage().persistent().set(&DataKey::InterestRateBps, &rate_bps);
    }

    /// Accrue interest for a single depositor.
    ///
    /// Calculates interest = balance * rate_bps * elapsed_seconds / (10000 * seconds_per_year)
    /// and credits it to the vault's internal balance. The contract must hold sufficient
    /// USDC to cover the increased balance when the user later withdraws.
    pub fn accrue_interest(env: Env, admin: Address, user: Address) {
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("Contract not initialized");
        if admin != stored_admin {
            panic!("unauthorized: caller is not admin");
        }

        let rate_bps: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::InterestRateBps)
            .unwrap_or(0);
        if rate_bps == 0 {
            panic!("interest rate not set");
        }

        let mut vault: Vault = env
            .storage()
            .persistent()
            .get(&DataKey::Vault(user.clone()))
            .expect("No vault found for user");

        let now = env.ledger().timestamp();
        let elapsed = now.saturating_sub(vault.last_accrue_time);

        let interest = (vault.balance * rate_bps as i128 * elapsed as i128)
            / (10_000i128 * SECONDS_PER_YEAR as i128);

        if interest <= 0 {
            return;
        }

        vault.balance += interest;
        vault.last_accrue_time = now;
        env.storage()
            .persistent()
            .set(&DataKey::Vault(user.clone()), &vault);

        env.events().publish(
            (Symbol::new(&env, "AccrueInterest"),),
            AccrueInterestEvent {
                user,
                interest,
                new_balance: vault.balance,
            },
        );
    }

    pub fn deposit(env: Env, user: Address, amount: i128, unlock_time: u64) {
        user.require_auth();
        if amount <= 0 {
            panic!("Amount must be positive");
        }
        if unlock_time <= env.ledger().timestamp() {
            panic!("Unlock time must be in the future");
        }

        let token_address: Address = env
            .storage()
            .persistent()
            .get(&DataKey::TokenAddress)
            .expect("Contract not initialized");

        token::Client::new(&env, &token_address).transfer_from(
            &env.current_contract_address(),
            &user,
            &env.current_contract_address(),
            &amount,
        );

        let now = env.ledger().timestamp();
        let mut vault = env
            .storage()
            .persistent()
            .get(&DataKey::Vault(user.clone()))
            .unwrap_or(Vault {
                balance: 0,
                unlock_time: 0,
                last_accrue_time: now,
            });

        vault.balance += amount;
        if unlock_time > vault.unlock_time {
            vault.unlock_time = unlock_time;
        }

        env.storage()
            .persistent()
            .set(&DataKey::Vault(user.clone()), &vault);

        env.events().publish(
            (Symbol::new(&env, "Deposit"),),
            DepositEvent {
                user,
                amount,
                unlock_time: vault.unlock_time,
            },
        );
    }

    pub fn withdraw(env: Env, user: Address, amount: i128) {
        user.require_auth();
        if amount <= 0 {
            panic!("Amount must be positive");
        }

        let mut vault: Vault = env
            .storage()
            .persistent()
            .get(&DataKey::Vault(user.clone()))
            .expect("No vault found for user");

        if vault.balance < amount {
            panic!("Insufficient balance");
        }

        let token_address: Address = env
            .storage()
            .persistent()
            .get(&DataKey::TokenAddress)
            .unwrap();

        let now = env.ledger().timestamp();
        let penalty = if now < vault.unlock_time {
            (amount * EARLY_WITHDRAWAL_PENALTY_BPS as i128) / 10000
        } else {
            0
        };

        let withdraw_amount = amount - penalty;

        token::Client::new(&env, &token_address).transfer(
            &env.current_contract_address(),
            &user,
            &withdraw_amount,
        );

        vault.balance -= amount;
        env.storage()
            .persistent()
            .set(&DataKey::Vault(user.clone()), &vault);

        env.events().publish(
            (Symbol::new(&env, "Withdrawal"),),
            WithdrawalEvent {
                user,
                amount: withdraw_amount,
                penalty,
            },
        );
    }

    pub fn get_balance(env: Env, user: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Vault(user))
            .map(|v: Vault| v.balance)
            .unwrap_or(0)
    }

    pub fn get_unlock_time(env: Env, user: Address) -> u64 {
        env.storage()
            .persistent()
            .get(&DataKey::Vault(user))
            .map(|v: Vault| v.unlock_time)
            .unwrap_or(0)
    }
}
