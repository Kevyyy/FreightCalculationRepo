/**
 * fulfillment router.
 */

export default {
  routes: [
    {
      method: 'POST',
      path: '/fulfillment/calculate-shipping',
      handler: 'fulfillment.calculateShipping',
      config: {
        policies: [],
        middlewares: [],
      },
    },
  ],
};

