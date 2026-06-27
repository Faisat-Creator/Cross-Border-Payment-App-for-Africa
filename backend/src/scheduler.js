const cron = require('node-cron');
const logger = require('./utils/logger');
const { processScheduledPayments } = require('./jobs/scheduledPaymentsJob');
const { indexContractEvents } = require('./jobs/contractEventIndexer');
const { checkClaimableBalanceExpiry } = require('./jobs/checkClaimableBalanceExpiry');
const { syncOfferEvents } = require('./jobs/syncOfferEvents');

// Configurable cron expressions — fall back to sensible defaults
const PAYMENTS_CRON   = process.env.CRON_SCHEDULED_PAYMENTS   || '* * * * *';   // every minute
const INDEXER_CRON    = process.env.CRON_CONTRACT_INDEXER      || '*/2 * * * *'; // every 2 minutes
const EXPIRY_CRON     = process.env.CRON_CLAIMABLE_EXPIRY      || '*/15 * * * *'; // every 15 minutes
const OFFER_SYNC_CRON = process.env.CRON_OFFER_SYNC            || '*/2 * * * *'; // every 2 minutes

// Wrap a job so overlapping runs are skipped and errors are always caught
function safeJob(name, fn) {
  let running = false;
  return async () => {
    if (running) {
      logger.debug(`${name}: previous run still in progress, skipping`);
      return;
    }
    running = true;
    try {
      await fn();
    } catch (err) {
      logger.error(`${name}: unhandled error`, { error: err.message, stack: err.stack });
    } finally {
      running = false;
    }
  };
}

function startScheduler() {
  cron.schedule(PAYMENTS_CRON, safeJob('scheduledPaymentsJob', processScheduledPayments));
  logger.info('Scheduled payments job registered', { cron: PAYMENTS_CRON });

  cron.schedule(INDEXER_CRON, safeJob('contractEventIndexer', indexContractEvents));
  logger.info('Contract event indexer job registered', { cron: INDEXER_CRON });

  cron.schedule(EXPIRY_CRON, safeJob('checkClaimableBalanceExpiry', checkClaimableBalanceExpiry));
  logger.info('Claimable balance expiry job registered', { cron: EXPIRY_CRON });

  cron.schedule(OFFER_SYNC_CRON, safeJob('syncOfferEvents', syncOfferEvents));
  logger.info('DEX offer event sync job registered', { cron: OFFER_SYNC_CRON });
}

module.exports = { startScheduler };
