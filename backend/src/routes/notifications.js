const router = require('express').Router();
const authMiddleware = require('../middleware/auth');
const { subscribe, unsubscribe } = require('../controllers/notificationController');

router.use(authMiddleware);

/**
 * @swagger
 * /api/notifications/subscribe:
 *   post:
 *     summary: Subscribe to Web Push notifications
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [subscription]
 *             properties:
 *               subscription:
 *                 type: object
 *                 description: PushSubscriptionJSON from the browser Push API
 *     responses:
 *       200:
 *         description: Push subscription saved
 *       400:
 *         description: Invalid push subscription
 *   delete:
 *     summary: Unsubscribe from Web Push notifications
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Push subscription removed
 */
router.post('/subscribe', subscribe);
router.delete('/subscribe', unsubscribe);

module.exports = router;
