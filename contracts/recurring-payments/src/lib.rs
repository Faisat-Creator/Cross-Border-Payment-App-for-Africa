#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, token, Address, Env, Symbol};

mod test;

// ── Storage keys ──────────────────────────────────────────────────────────────

#[contracttype]
pub enum DataKey {
    TokenAddress,
    Schedule(u64),
    Counter,
}

// ── Data types ────────────────────────────────────────────────────────────────

/// Frequency of a recurring payment, expressed in seconds.
pub type IntervalSecs = u64;

#[derive(Clone, PartialEq, Eq)]
#[contracttype]
pub enum ScheduleStatus {
    Active,
    Cancelled,
    Paused,
}

#[derive(Clone)]
#[contracttype]
pub struct RecurringSchedule {
    pub id: u64,
    pub sender: Address,
    pub recipient: Address,
    pub asset: Address,
    /// Amount per payment in stroops.
    pub amount: i128,
    /// Interval between payments in seconds (e.g. 86400 = daily).
    pub interval: IntervalSecs,
    /// Ledger timestamp of the next allowed execution.
    pub next_payment_at: u64,
    /// Maximum number of payments to execute (0 = unlimited).
    pub max_executions: u64,
    /// Number of payments executed so far.
    pub executions_completed: u64,
    pub status: ScheduleStatus,
}

// ── Events ────────────────────────────────────────────────────────────────────

#[derive(Clone)]
#[contracttype]
pub struct ScheduleAuthorized {
    pub id: u64,
    pub sender: Address,
    pub recipient: Address,
    pub asset: Address,
    pub amount: i128,
    pub interval: u64,
    pub next_payment_at: u64,
    pub max_executions: u64,
}

#[derive(Clone)]
#[contracttype]
pub struct PaymentExecuted {
    pub id: u64,
    pub executor: Address,
    pub amount: i128,
    pub next_payment_at: u64,
    pub executions_completed: u64,
}

#[derive(Clone)]
#[contracttype]
pub struct ScheduleCancelled {
    pub id: u64,
}

#[derive(Clone)]
#[contracttype]
pub struct SchedulePaused {
    pub id: u64,
}

#[derive(Clone)]
#[contracttype]
pub struct ScheduleResumed {
    pub id: u64,
}

// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct RecurringPaymentsContract;

#[contractimpl]
impl RecurringPaymentsContract {
    /// One-time initializer — stores the token (USDC) contract address.
    pub fn initialize(env: Env, token_address: Address) {
        if env.storage().persistent().has(&DataKey::TokenAddress) {
            panic!("already initialized");
        }
        env.storage()
            .persistent()
            .set(&DataKey::TokenAddress, &token_address);
        env.storage()
            .persistent()
            .set(&DataKey::Counter, &0u64);
    }

    /// Sender authorizes a recurring transfer.
    /// The contract holds *no* funds — it only records the authorization.
    /// The sender must maintain sufficient token balance and allowance.
    ///
    /// Returns the new schedule ID.
    pub fn create_recurring_payment(
        env: Env,
        sender: Address,
        recipient: Address,
        asset: Address,
        amount: i128,
        interval: IntervalSecs,
        max_executions: u64,
    ) -> u64 {
        if amount <= 0 {
            panic!("amount must be positive");
        }
        if interval == 0 {
            panic!("interval must be > 0");
        }

        sender.require_auth();

        let id = Self::next_id(&env);
        let now = env.ledger().timestamp();

        let schedule = RecurringSchedule {
            id,
            sender: sender.clone(),
            recipient: recipient.clone(),
            asset: asset.clone(),
            amount,
            interval,
            next_payment_at: now + interval,
            max_executions,
            executions_completed: 0,
            status: ScheduleStatus::Active,
        };

        env.storage()
            .persistent()
            .set(&DataKey::Schedule(id), &schedule);

        env.events().publish(
            (Symbol::new(&env, "ScheduleAuthorized"),),
            ScheduleAuthorized {
                id,
                sender,
                recipient,
                asset,
                amount,
                interval,
                next_payment_at: now + interval,
                max_executions,
            },
        );

        id
    }

    /// Deprecated alias for create_recurring_payment. Use create_recurring_payment instead.
    #[deprecated]
    pub fn authorize_recurring(
        env: Env,
        sender: Address,
        recipient: Address,
        amount: i128,
        interval: IntervalSecs,
    ) -> u64 {
        // Legacy support: default to USDC asset (0-address as placeholder)
        let usdc_placeholder = Address::from_contract_id(&env, &[0u8; 32]);
        Self::create_recurring_payment(env, sender, recipient, usdc_placeholder, amount, interval, 0)
    }

    /// Execute a due payment for `schedule_id`.
    /// Anyone may call this (permissionless / incentivized execution).
    /// Panics if the schedule is not yet due or is not active.
    pub fn execute_payment(env: Env, executor: Address, schedule_id: u64) {
        executor.require_auth();

        let mut schedule: RecurringSchedule = env
            .storage()
            .persistent()
            .get(&DataKey::Schedule(schedule_id))
            .expect("schedule not found");

        if schedule.status != ScheduleStatus::Active {
            panic!("schedule is not active");
        }

        let now = env.ledger().timestamp();
        if now < schedule.next_payment_at {
            panic!("payment not yet due");
        }

        // Check if max executions would be exceeded
        if schedule.max_executions > 0 && schedule.executions_completed >= schedule.max_executions {
            panic!("maximum executions reached");
        }

        let token_address: Address = env
            .storage()
            .persistent()
            .get(&DataKey::TokenAddress)
            .expect("not initialized");

        // Pull funds directly from sender → recipient (no custody).
        token::Client::new(&env, &token_address).transfer_from(
            &env.current_contract_address(),
            &schedule.sender,
            &schedule.recipient,
            &schedule.amount,
        );

        schedule.next_payment_at = now + schedule.interval;
        schedule.executions_completed += 1;

        // Cancel schedule if max executions reached
        if schedule.max_executions > 0 && schedule.executions_completed >= schedule.max_executions {
            schedule.status = ScheduleStatus::Cancelled;
        }

        env.storage()
            .persistent()
            .set(&DataKey::Schedule(schedule_id), &schedule);

        env.events().publish(
            (Symbol::new(&env, "PaymentExecuted"),),
            PaymentExecuted {
                id: schedule_id,
                executor,
                amount: schedule.amount,
                next_payment_at: schedule.next_payment_at,
                executions_completed: schedule.executions_completed,
            },
        );
    }

    /// Cancel a recurring schedule. Only the original sender may cancel.
    /// A paused schedule may also be cancelled.
    pub fn cancel_recurring_payment(env: Env, sender: Address, schedule_id: u64) {
        sender.require_auth();

        let mut schedule: RecurringSchedule = env
            .storage()
            .persistent()
            .get(&DataKey::Schedule(schedule_id))
            .expect("schedule not found");

        if schedule.sender != sender {
            panic!("only the sender can cancel");
        }
        if schedule.status == ScheduleStatus::Cancelled {
            panic!("schedule is already cancelled");
        }

        schedule.status = ScheduleStatus::Cancelled;
        env.storage()
            .persistent()
            .set(&DataKey::Schedule(schedule_id), &schedule);

        env.events().publish(
            (Symbol::new(&env, "ScheduleCancelled"),),
            ScheduleCancelled { id: schedule_id },
        );
    }

    /// Pause a recurring schedule. Only the original sender may pause.
    /// A paused schedule will not execute until resumed.
    pub fn pause_recurring_payment(env: Env, sender: Address, schedule_id: u64) {
        sender.require_auth();

        let mut schedule: RecurringSchedule = env
            .storage()
            .persistent()
            .get(&DataKey::Schedule(schedule_id))
            .expect("schedule not found");

        if schedule.sender != sender {
            panic!("only the sender can pause");
        }
        if schedule.status != ScheduleStatus::Active {
            panic!("schedule is not active");
        }

        schedule.status = ScheduleStatus::Paused;
        env.storage()
            .persistent()
            .set(&DataKey::Schedule(schedule_id), &schedule);

        env.events().publish(
            (Symbol::new(&env, "SchedulePaused"),),
            SchedulePaused { id: schedule_id },
        );
    }

    /// Resume a paused recurring schedule. Only the original sender may resume.
    pub fn resume_recurring_payment(env: Env, sender: Address, schedule_id: u64) {
        sender.require_auth();

        let mut schedule: RecurringSchedule = env
            .storage()
            .persistent()
            .get(&DataKey::Schedule(schedule_id))
            .expect("schedule not found");

        if schedule.sender != sender {
            panic!("only the sender can resume");
        }
        if schedule.status != ScheduleStatus::Paused {
            panic!("schedule is not paused");
        }

        schedule.status = ScheduleStatus::Active;
        env.storage()
            .persistent()
            .set(&DataKey::Schedule(schedule_id), &schedule);

        env.events().publish(
            (Symbol::new(&env, "ScheduleResumed"),),
            ScheduleResumed { id: schedule_id },
        );
    }

    /// Deprecated alias for cancel_recurring_payment. Use cancel_recurring_payment instead.
    #[deprecated]
    pub fn cancel_recurring(env: Env, sender: Address, schedule_id: u64) {
        Self::cancel_recurring_payment(env, sender, schedule_id)
    }

    /// Read a schedule by ID.
    pub fn get_recurring_payment(env: Env, schedule_id: u64) -> RecurringSchedule {
        env.storage()
            .persistent()
            .get(&DataKey::Schedule(schedule_id))
            .expect("schedule not found")
    }

    /// Deprecated alias for get_recurring_payment. Use get_recurring_payment instead.
    #[deprecated]
    pub fn get_schedule(env: Env, schedule_id: u64) -> RecurringSchedule {
        Self::get_recurring_payment(env, schedule_id)
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    fn next_id(env: &Env) -> u64 {
        let current: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::Counter)
            .unwrap_or(0);
        let next = current + 1;
        env.storage()
            .persistent()
            .set(&DataKey::Counter, &next);
        next
    }
}
