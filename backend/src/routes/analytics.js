const router = require('express').Router();
const authMiddleware = require('../middleware/auth');
const { summary } = require('../controllers/analyticsController');

router.use(authMiddleware);

router.get('/summary', summary);

module.exports = router;
