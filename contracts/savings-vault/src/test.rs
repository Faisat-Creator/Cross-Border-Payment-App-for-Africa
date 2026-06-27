#![cfg(test)]

use soroban_sdk::{
    testutils::{Address as _, Events, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, IntoVal, Symbol, Val,
};

use crate::{AccrueInterestEvent, SavingsVaultContract, SavingsVaultContractClient};

fn setup() -> (Env, SavingsVaultContractClient<'static>, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, SavingsVaultContract);
    let client = SavingsVaultContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let usdc_id = env.register_stellar_asset_contract_v2(admin.clone()).address();
    client.initialize(&admin, &usdc_id);
    (env, client, admin, usdc_id)
}

fn mint_usdc(env: &Env, usdc_id: &Address, _admin: &Address, to: &Address, amount: i128) {
    StellarAssetClient::new(env, usdc_id).mint(to, &amount);
}

#[test]
fn test_initialize() {
    let (_, client, _, usdc_id) = setup();
    // Initialization is tested implicitly - contract would panic if not initialized
    assert!(true);
}

#[test]
#[should_panic(expected = "Contract already initialized")]
fn test_double_initialize() {
    let (_, client, admin, usdc_id) = setup();
    client.initialize(&admin, &usdc_id);
}

#[test]
fn test_deposit() {
    let (env, client, admin, usdc_id) = setup();
    let user = Address::generate(&env);
    let amount = 1_000_0000000i128;
    let unlock_time = env.ledger().timestamp() + 86400;

    mint_usdc(&env, &usdc_id, &admin, &user, amount);

    client.deposit(&user, &amount, &unlock_time);

    assert_eq!(client.get_balance(&user), amount);
    assert_eq!(client.get_unlock_time(&user), unlock_time);
}

#[test]
#[should_panic(expected = "Amount must be positive")]
fn test_deposit_zero_amount() {
    let (env, client, _, _) = setup();
    let user = Address::generate(&env);
    client.deposit(&user, &0, &env.ledger().timestamp() + 86400);
}

#[test]
#[should_panic(expected = "Unlock time must be in the future")]
fn test_deposit_past_unlock_time() {
    let (env, client, admin, usdc_id) = setup();
    let user = Address::generate(&env);
    let amount = 1_000_0000000i128;
    let past_time = env.ledger().timestamp() - 1;

    mint_usdc(&env, &usdc_id, &admin, &user, amount);
    client.deposit(&user, &amount, &past_time);
}

#[test]
fn test_withdraw_after_unlock() {
    let (env, client, admin, usdc_id) = setup();
    let user = Address::generate(&env);
    let amount = 1_000_0000000i128;
    let unlock_time = env.ledger().timestamp() + 3600;

    mint_usdc(&env, &usdc_id, &admin, &user, amount);
    client.deposit(&user, &amount, &unlock_time);

    env.ledger().set_timestamp(unlock_time + 1);

    client.withdraw(&user, &amount);

    assert_eq!(client.get_balance(&user), 0);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&user), amount);
}

#[test]
fn test_early_withdrawal_with_penalty() {
    let (env, client, admin, usdc_id) = setup();
    let user = Address::generate(&env);
    let amount = 1_000_0000000i128;
    let unlock_time = env.ledger().timestamp() + 86400;

    mint_usdc(&env, &usdc_id, &admin, &user, amount);
    client.deposit(&user, &amount, &unlock_time);

    client.withdraw(&user, &amount);

    let expected_penalty = (amount * 1000) / 10000;
    let expected_withdrawal = amount - expected_penalty;

    assert_eq!(client.get_balance(&user), 0);
    assert_eq!(TokenClient::new(&env, &usdc_id).balance(&user), expected_withdrawal);
}

#[test]
#[should_panic(expected = "Insufficient balance")]
fn test_withdraw_more_than_balance() {
    let (env, client, admin, usdc_id) = setup();
    let user = Address::generate(&env);
    let deposit_amount = 500_0000000i128;
    let withdraw_amount = 1_000_0000000i128;
    let unlock_time = env.ledger().timestamp() + 3600;

    mint_usdc(&env, &usdc_id, &admin, &user, deposit_amount);
    client.deposit(&user, &deposit_amount, &unlock_time);

    client.withdraw(&user, &withdraw_amount);
}

#[test]
#[should_panic(expected = "No vault found for user")]
fn test_withdraw_no_vault() {
    let (env, client, _, _) = setup();
    let user = Address::generate(&env);
    client.withdraw(&user, &1_000_0000000);
}

#[test]
fn test_multiple_deposits() {
    let (env, client, admin, usdc_id) = setup();
    let user = Address::generate(&env);
    let amount1 = 500_0000000i128;
    let amount2 = 300_0000000i128;
    let unlock_time1 = env.ledger().timestamp() + 3600;
    let unlock_time2 = env.ledger().timestamp() + 7200;

    mint_usdc(&env, &usdc_id, &admin, &user, amount1 + amount2);

    client.deposit(&user, &amount1, &unlock_time1);
    client.deposit(&user, &amount2, &unlock_time2);

    assert_eq!(client.get_balance(&user), amount1 + amount2);
    assert_eq!(client.get_unlock_time(&user), unlock_time2);
}

#[test]
fn test_get_balance_no_vault() {
    let (_, client, _, _) = setup();
    let user = Address::generate(&client.env());
    assert_eq!(client.get_balance(&user), 0);
}

#[test]
fn test_get_unlock_time_no_vault() {
    let (_, client, _, _) = setup();
    let user = Address::generate(&client.env());
    assert_eq!(client.get_unlock_time(&user), 0);
}

// ── #548: interest accrual ────────────────────────────────────────────────────

#[test]
fn test_set_interest_rate() {
    let (_, client, admin, _) = setup();
    client.set_interest_rate(&admin, &500u32);
    // No panic = success; rate is stored and used by accrue_interest
}

#[test]
#[should_panic(expected = "unauthorized: caller is not admin")]
fn test_set_interest_rate_non_admin_panics() {
    let (env, client, _, _) = setup();
    let impostor = Address::generate(&env);
    client.set_interest_rate(&impostor, &500u32);
}

#[test]
fn test_accrue_interest_credits_vault_balance() {
    let (env, client, admin, usdc_id) = setup();
    let user = Address::generate(&env);
    let deposit = 1_000_0000000i128; // 1000 USDC
    let unlock_time = env.ledger().timestamp() + 2 * 365 * 24 * 60 * 60;

    mint_usdc(&env, &usdc_id, &admin, &user, deposit);
    client.deposit(&user, &deposit, &unlock_time);
    client.set_interest_rate(&admin, &500u32); // 5% per year

    // Advance 1 year
    env.ledger().with_mut(|li| li.timestamp += 31_536_000);

    client.accrue_interest(&admin, &user);

    // 5% of 1000 USDC = 50 USDC
    let expected_interest = 50_0000000i128;
    assert_eq!(client.get_balance(&user), deposit + expected_interest);
}

#[test]
fn test_accrue_interest_emits_event() {
    let (env, client, admin, usdc_id) = setup();
    let user = Address::generate(&env);
    let deposit = 1_000_0000000i128;
    let unlock_time = env.ledger().timestamp() + 2 * 365 * 24 * 60 * 60;

    mint_usdc(&env, &usdc_id, &admin, &user, deposit);
    client.deposit(&user, &deposit, &unlock_time);
    client.set_interest_rate(&admin, &500u32);

    env.ledger().with_mut(|li| li.timestamp += 31_536_000);
    client.accrue_interest(&admin, &user);

    let event_name: Val = Symbol::new(&env, "AccrueInterest").into_val(&env);
    let events = env.events().all();
    let accrual_event = events.iter().find(|(_, topics, _)| {
        topics.iter().any(|t| t == &event_name)
    });
    assert!(accrual_event.is_some(), "AccrueInterest event not emitted");

    let (_, _, data) = accrual_event.unwrap();
    let payload: AccrueInterestEvent = soroban_sdk::from_val(&env, data);
    assert_eq!(payload.user, user);
    assert_eq!(payload.interest, 50_0000000i128);
    assert_eq!(payload.new_balance, deposit + 50_0000000i128);
}

#[test]
#[should_panic(expected = "interest rate not set")]
fn test_accrue_interest_without_rate_panics() {
    let (env, client, admin, usdc_id) = setup();
    let user = Address::generate(&env);
    let deposit = 1_000_0000000i128;
    let unlock_time = env.ledger().timestamp() + 86400;

    mint_usdc(&env, &usdc_id, &admin, &user, deposit);
    client.deposit(&user, &deposit, &unlock_time);

    env.ledger().with_mut(|li| li.timestamp += 86400);
    client.accrue_interest(&admin, &user);
}

#[test]
#[should_panic(expected = "unauthorized: caller is not admin")]
fn test_accrue_interest_non_admin_panics() {
    let (env, client, admin, usdc_id) = setup();
    let user = Address::generate(&env);
    let deposit = 1_000_0000000i128;
    let unlock_time = env.ledger().timestamp() + 86400;

    mint_usdc(&env, &usdc_id, &admin, &user, deposit);
    client.deposit(&user, &deposit, &unlock_time);
    client.set_interest_rate(&admin, &500u32);

    let impostor = Address::generate(&env);
    env.ledger().with_mut(|li| li.timestamp += 86400);
    client.accrue_interest(&impostor, &user);
}
