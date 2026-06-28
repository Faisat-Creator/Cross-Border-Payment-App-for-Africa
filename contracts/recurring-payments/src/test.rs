#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger, LedgerInfo},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

fn setup() -> (Env, Address, Address, Address, Address, Address, Address) {
    setup_with_fee(0)
}

fn setup_with_fee(fee_bps: u32) -> (Env, Address, Address, Address, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    // Deploy a mock USDC token
    let token_admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract(token_admin.clone());

    let admin = Address::generate(&env);

    // Deploy the recurring-payments contract
    let contract_id = env.register_contract(None, RecurringPaymentsContract);
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    client.initialize(&admin, &token_id, &fee_bps);

    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let executor = Address::generate(&env);

    // Fund sender with 10_000 USDC (7 decimals)
    StellarAssetClient::new(&env, &token_id).mint(&sender, &10_000_0000000);

    // Approve the contract to pull from sender
    TokenClient::new(&env, &token_id).approve(
        &sender,
        &contract_id,
        &i128::MAX,
        &(env.ledger().sequence() + 10_000),
    );

    (env, contract_id, token_id, sender, recipient, executor, admin)
}

fn advance_time(env: &Env, secs: u64) {
    let info = env.ledger().get();
    env.ledger().set(LedgerInfo {
        timestamp: info.timestamp + secs,
        ..info
    });
}

fn token_balance(env: &Env, token_id: &Address, account: &Address) -> i128 {
    TokenClient::new(env, token_id).balance(account)
}

// ── initialize ────────────────────────────────────────────────────────────────

#[test]
fn test_initialize_ok() {
    let env = Env::default();
    env.mock_all_auths();
    let token_admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract(token_admin);
    let admin = Address::generate(&env);
    let contract_id = env.register_contract(None, RecurringPaymentsContract);
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    client.initialize(&admin, &token_id, &0); // must not panic
}

#[test]
#[should_panic(expected = "already initialized")]
fn test_initialize_twice_panics() {
    let (env, contract_id, token_id, _, _, _, _) = setup();
    let admin = Address::generate(&env);
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    client.initialize(&admin, &token_id, &0);
}

#[test]
#[should_panic(expected = "fee_bps must be <= 10000")]
fn test_initialize_fee_bps_too_high_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let token_admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract(token_admin);
    let admin = Address::generate(&env);
    let contract_id = env.register_contract(None, RecurringPaymentsContract);
    RecurringPaymentsContractClient::new(&env, &contract_id).initialize(&admin, &token_id, &10_001);
}

// ── authorize_recurring ───────────────────────────────────────────────────────

#[test]
fn test_authorize_recurring_returns_id_one() {
    let (env, contract_id, _, sender, recipient, _, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = client.authorize_recurring(&sender, &recipient, &1_000_0000000, &86400);
    assert_eq!(id, 1);
}

#[test]
fn test_authorize_recurring_stores_schedule() {
    let (env, contract_id, _, sender, recipient, _, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = client.authorize_recurring(&sender, &recipient, &500_0000000, &3600);
    let s = client.get_schedule(&id);
    assert_eq!(s.sender, sender);
    assert_eq!(s.recipient, recipient);
    assert_eq!(s.amount, 500_0000000);
    assert_eq!(s.interval, 3600);
    assert_eq!(s.status, ScheduleStatus::Active);
}

#[test]
fn test_authorize_recurring_ids_increment() {
    let (env, contract_id, _, sender, recipient, _, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id1 = client.authorize_recurring(&sender, &recipient, &100_0000000, &86400);
    let id2 = client.authorize_recurring(&sender, &recipient, &200_0000000, &86400);
    assert_eq!(id1, 1);
    assert_eq!(id2, 2);
}

#[test]
#[should_panic(expected = "amount must be positive")]
fn test_authorize_zero_amount_panics() {
    let (env, contract_id, _, sender, recipient, _, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    client.authorize_recurring(&sender, &recipient, &0, &86400);
}

#[test]
#[should_panic(expected = "amount must be positive")]
fn test_authorize_negative_amount_panics() {
    let (env, contract_id, _, sender, recipient, _, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    client.authorize_recurring(&sender, &recipient, &-1, &86400);
}

#[test]
#[should_panic(expected = "interval must be > 0")]
fn test_authorize_zero_interval_panics() {
    let (env, contract_id, _, sender, recipient, _, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    client.authorize_recurring(&sender, &recipient, &100_0000000, &0);
}

// ── execute_payment ───────────────────────────────────────────────────────────

#[test]
fn test_execute_payment_transfers_funds() {
    let (env, contract_id, token_id, sender, recipient, executor, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let amount = 1_000_0000000i128;
    let id = client.authorize_recurring(&sender, &recipient, &amount, &86400);

    advance_time(&env, 86400);

    let before = token_balance(&env, &token_id, &recipient);
    client.execute_payment(&executor, &id);
    let after = token_balance(&env, &token_id, &recipient);
    assert_eq!(after - before, amount);
}

#[test]
fn test_execute_payment_advances_next_payment_at() {
    let (env, contract_id, _, sender, recipient, executor, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = client.authorize_recurring(&sender, &recipient, &100_0000000, &86400);

    advance_time(&env, 86400);
    let ts_before_exec = env.ledger().timestamp();
    client.execute_payment(&executor, &id);

    let s = client.get_schedule(&id);
    assert_eq!(s.next_payment_at, ts_before_exec + 86400);
}

#[test]
fn test_execute_payment_multiple_cycles() {
    let (env, contract_id, token_id, sender, recipient, executor, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let amount = 500_0000000i128;
    let id = client.authorize_recurring(&sender, &recipient, &amount, &86400);

    for _ in 0..3 {
        advance_time(&env, 86400);
        client.execute_payment(&executor, &id);
    }

    assert_eq!(token_balance(&env, &token_id, &recipient), amount * 3);
}

#[test]
#[should_panic(expected = "payment not yet due")]
fn test_execute_payment_too_early_panics() {
    let (env, contract_id, _, sender, recipient, executor, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = client.authorize_recurring(&sender, &recipient, &100_0000000, &86400);
    // Do NOT advance time
    client.execute_payment(&executor, &id);
}

#[test]
#[should_panic(expected = "schedule not found")]
fn test_execute_payment_unknown_id_panics() {
    let (env, contract_id, _, _, _, executor, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    client.execute_payment(&executor, &999);
}

#[test]
#[should_panic(expected = "schedule is not active")]
fn test_execute_payment_on_cancelled_schedule_panics() {
    let (env, contract_id, _, sender, recipient, executor, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = client.authorize_recurring(&sender, &recipient, &100_0000000, &86400);
    client.cancel_recurring(&sender, &id);

    advance_time(&env, 86400);
    client.execute_payment(&executor, &id);
}

// ── cancel_recurring ──────────────────────────────────────────────────────────

#[test]
fn test_cancel_sets_status_cancelled() {
    let (env, contract_id, _, sender, recipient, _, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = client.authorize_recurring(&sender, &recipient, &100_0000000, &86400);
    client.cancel_recurring(&sender, &id);
    let s = client.get_schedule(&id);
    assert_eq!(s.status, ScheduleStatus::Cancelled);
}

#[test]
#[should_panic(expected = "only the sender can cancel")]
fn test_cancel_by_non_sender_panics() {
    let (env, contract_id, _, sender, recipient, executor, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = client.authorize_recurring(&sender, &recipient, &100_0000000, &86400);
    client.cancel_recurring(&executor, &id); // executor is not the sender
}

#[test]
#[should_panic(expected = "schedule is already cancelled")]
fn test_cancel_already_cancelled_panics() {
    let (env, contract_id, _, sender, recipient, _, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = client.authorize_recurring(&sender, &recipient, &100_0000000, &86400);
    client.cancel_recurring(&sender, &id);
    client.cancel_recurring(&sender, &id); // second cancel must panic
}

#[test]
#[should_panic(expected = "schedule not found")]
fn test_cancel_unknown_id_panics() {
    let (env, contract_id, _, sender, ..) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    client.cancel_recurring(&sender, &999);
}

// ── get_schedule ──────────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "schedule not found")]
fn test_get_schedule_unknown_id_panics() {
    let (env, contract_id, ..) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    client.get_schedule(&999);
}

// ── #550: pause / resume ──────────────────────────────────────────────────────

#[test]
fn test_pause_sets_status_paused() {
    let (env, contract_id, _, sender, recipient, _, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = client.authorize_recurring(&sender, &recipient, &100_0000000, &86400);
    client.pause_recurring_payment(&sender, &id);
    let s = client.get_recurring_payment(&id);
    assert_eq!(s.status, ScheduleStatus::Paused);
}

#[test]
fn test_resume_sets_status_active() {
    let (env, contract_id, _, sender, recipient, _, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = client.authorize_recurring(&sender, &recipient, &100_0000000, &86400);
    client.pause_recurring_payment(&sender, &id);
    client.resume_recurring_payment(&sender, &id);
    let s = client.get_recurring_payment(&id);
    assert_eq!(s.status, ScheduleStatus::Active);
}

#[test]
#[should_panic(expected = "schedule is not active")]
fn test_execute_payment_while_paused_panics() {
    let (env, contract_id, _, sender, recipient, executor, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = client.authorize_recurring(&sender, &recipient, &100_0000000, &86400);
    client.pause_recurring_payment(&sender, &id);
    advance_time(&env, 86400);
    client.execute_payment(&executor, &id);
}

#[test]
fn test_resume_allows_execution() {
    let (env, contract_id, token_id, sender, recipient, executor, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let amount = 100_0000000i128;
    let id = client.authorize_recurring(&sender, &recipient, &amount, &86400);
    client.pause_recurring_payment(&sender, &id);
    advance_time(&env, 86400);
    client.resume_recurring_payment(&sender, &id);
    client.execute_payment(&executor, &id);
    assert_eq!(token_balance(&env, &token_id, &recipient), amount);
}

#[test]
#[should_panic(expected = "only the sender can pause")]
fn test_pause_by_non_sender_panics() {
    let (env, contract_id, _, sender, recipient, executor, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = client.authorize_recurring(&sender, &recipient, &100_0000000, &86400);
    client.pause_recurring_payment(&executor, &id);
}

#[test]
#[should_panic(expected = "only the sender can resume")]
fn test_resume_by_non_sender_panics() {
    let (env, contract_id, _, sender, recipient, executor, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = client.authorize_recurring(&sender, &recipient, &100_0000000, &86400);
    client.pause_recurring_payment(&sender, &id);
    client.resume_recurring_payment(&executor, &id);
}

#[test]
#[should_panic(expected = "schedule is not active")]
fn test_pause_already_paused_panics() {
    let (env, contract_id, _, sender, recipient, _, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = client.authorize_recurring(&sender, &recipient, &100_0000000, &86400);
    client.pause_recurring_payment(&sender, &id);
    client.pause_recurring_payment(&sender, &id);
}

#[test]
#[should_panic(expected = "schedule is not paused")]
fn test_resume_active_schedule_panics() {
    let (env, contract_id, _, sender, recipient, _, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = client.authorize_recurring(&sender, &recipient, &100_0000000, &86400);
    client.resume_recurring_payment(&sender, &id);
}

#[test]
fn test_cancel_paused_schedule() {
    let (env, contract_id, _, sender, recipient, _, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = client.authorize_recurring(&sender, &recipient, &100_0000000, &86400);
    client.pause_recurring_payment(&sender, &id);
    client.cancel_recurring_payment(&sender, &id);
    let s = client.get_recurring_payment(&id);
    assert_eq!(s.status, ScheduleStatus::Cancelled);
}

// ── #551: max_executions ──────────────────────────────────────────────────────

#[test]
fn test_max_executions_auto_cancels_schedule() {
    let (env, contract_id, token_id, sender, recipient, executor, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = client.create_recurring_payment(&sender, &recipient, &token_id, &100_0000000, &86400, &2);

    advance_time(&env, 86400);
    client.execute_payment(&executor, &id);
    assert_eq!(client.get_recurring_payment(&id).status, ScheduleStatus::Active);

    advance_time(&env, 86400);
    client.execute_payment(&executor, &id);
    assert_eq!(client.get_recurring_payment(&id).status, ScheduleStatus::Cancelled);
    assert_eq!(client.get_recurring_payment(&id).executions_completed, 2);
}

#[test]
#[should_panic(expected = "schedule is not active")]
fn test_execute_payment_after_max_executions_panics() {
    let (env, contract_id, token_id, sender, recipient, executor, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let id = client.create_recurring_payment(&sender, &recipient, &token_id, &100_0000000, &86400, &1);

    advance_time(&env, 86400);
    client.execute_payment(&executor, &id);
    // schedule is now Cancelled — next call must panic
    advance_time(&env, 86400);
    client.execute_payment(&executor, &id);
}

#[test]
fn test_max_executions_zero_means_unlimited() {
    let (env, contract_id, token_id, sender, recipient, executor, _) = setup();
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let amount = 100_0000000i128;
    // max_executions = 0 → unlimited
    let id = client.create_recurring_payment(&sender, &recipient, &token_id, &amount, &86400, &0);

    for _ in 0..5 {
        advance_time(&env, 86400);
        client.execute_payment(&executor, &id);
    }
    assert_eq!(client.get_recurring_payment(&id).status, ScheduleStatus::Active);
    assert_eq!(token_balance(&env, &token_id, &recipient), amount * 5);
}

// ── #552: fee collection ──────────────────────────────────────────────────────

#[test]
fn test_fee_deducted_from_recipient_forwarded_to_admin() {
    let (env, contract_id, token_id, sender, recipient, executor, admin) = setup_with_fee(500); // 5 %
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let amount = 1_000_0000000i128;
    let id = client.authorize_recurring(&sender, &recipient, &amount, &86400);

    advance_time(&env, 86400);
    client.execute_payment(&executor, &id);

    let expected_fee = amount * 500 / 10_000; // 50_000_000
    let expected_net = amount - expected_fee;  // 950_000_000

    assert_eq!(token_balance(&env, &token_id, &recipient), expected_net);
    assert_eq!(token_balance(&env, &token_id, &admin), expected_fee);
}

#[test]
fn test_zero_fee_sends_full_amount_to_recipient() {
    let (env, contract_id, token_id, sender, recipient, executor, admin) = setup_with_fee(0);
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let amount = 1_000_0000000i128;
    let id = client.authorize_recurring(&sender, &recipient, &amount, &86400);

    advance_time(&env, 86400);
    client.execute_payment(&executor, &id);

    assert_eq!(token_balance(&env, &token_id, &recipient), amount);
    assert_eq!(token_balance(&env, &token_id, &admin), 0);
}

#[test]
fn test_fee_accumulates_over_multiple_executions() {
    let (env, contract_id, token_id, sender, recipient, executor, admin) = setup_with_fee(200); // 2 %
    let client = RecurringPaymentsContractClient::new(&env, &contract_id);
    let amount = 500_0000000i128;
    let id = client.authorize_recurring(&sender, &recipient, &amount, &86400);

    let fee_per_execution = amount * 200 / 10_000;
    let net_per_execution = amount - fee_per_execution;

    for i in 1..=3u32 {
        advance_time(&env, 86400);
        client.execute_payment(&executor, &id);
        assert_eq!(token_balance(&env, &token_id, &admin), fee_per_execution * i as i128);
        assert_eq!(token_balance(&env, &token_id, &recipient), net_per_execution * i as i128);
    }
}
