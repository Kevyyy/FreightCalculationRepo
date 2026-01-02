/**
 * Fulfillment controller for shipping calculation
 * Implements FreightCom API integration with Strapi fallback
 */

export default {
  async calculateShipping(ctx) {
    const cartId = ctx.request.body?.cart?.id || 'unknown';

    try {
      const { cart } = ctx.request.body;

      if (!cart) {
        return ctx.badRequest('Cart object is required');
      }

      if (
        (!cart.items || !Array.isArray(cart.items) || cart.items.length === 0) &&
        (!cart.boxes || !Array.isArray(cart.boxes) || cart.boxes.length === 0)
      ) {
        return ctx.badRequest('Either cart items array or boxes array is required');
      }

      if (cart.boxes && Array.isArray(cart.boxes)) {
        for (let i = 0; i < cart.boxes.length; i++) {
          const box = cart.boxes[i];
          if (!box.length || !box.width || !box.height || !box.weight) {
            return ctx.badRequest(
              `Box ${i + 1} is missing required fields: length, width, height, and weight are required`
            );
          }
        }
      }

      if (!cart.shipping_address?.postal_code) {
        return ctx.badRequest('Shipping address postal_code is required');
      }

      const strapiInstance = ctx.state?.strapi || (global as any).strapi;
      if (!strapiInstance) {
        throw new Error('Strapi instance not available');
      }

      const destinationPostalCode = cart.shipping_address.postal_code;
      const fulfillmentServiceFactory = require('../services/fulfillment').default;
      const fulfillmentService = fulfillmentServiceFactory({ strapi: strapiInstance });

      // Get origin postal code (service handles all priority logic)
      const originPostalCode = await fulfillmentService.getOriginPostalCode(
        cart.sales_channel_id,
        destinationPostalCode,
        cart.warehouse_id
      );

      let FreightComPrice: number | null = null;
      let freightComDiscountPercent = 0;

      // Attempt FreightCom API call
      try {
        const axios = require('axios');
        const FREIGHTCOM_API_KEY = process.env.FREIGHTCOM_API_KEY;
        const FREIGHTCOM_BASE_URL = process.env.FREIGHTCOM_BASE_URL || 'https://external-api.freightcom.com';

        if (!FREIGHTCOM_API_KEY) {
          throw new Error('FREIGHTCOM_API_KEY not configured in environment variables');
        }

        // Convert cart items/boxes to FreightCom API format
        const items = [];
        if (cart.boxes && Array.isArray(cart.boxes)) {
          for (const box of cart.boxes) {
            items.push({
              measurements: {
                weight: { unit: 'lb', value: box.weight },
                cuboid: { unit: 'in', l: box.length, w: box.width, h: box.height },
              },
              description: 'string',
              freight_class: 'string',
            });
          }
        } else {
          for (const item of cart.items || []) {
            const product = item.product || item.variant || {};
            const quantity = item.quantity || 1;
            for (let i = 0; i < quantity; i++) {
              items.push({
                measurements: {
                  weight: { unit: 'lb', value: product.weight || 0 },
                  cuboid: { unit: 'in', l: product.length || 0, w: product.width || 0, h: product.height || 0 },
                },
                description: 'string',
                freight_class: 'string',
              });
            }
          }
        }

        // Calculate delivery date (7 days from now)
        const deliveryDate = new Date();
        deliveryDate.setDate(deliveryDate.getDate() + 7);
        const day = String(deliveryDate.getDate()).padStart(2, '0');
        const month = String(deliveryDate.getMonth() + 1).padStart(2, '0');
        const year = deliveryDate.getFullYear();

        const client = axios.create({
          baseURL: FREIGHTCOM_BASE_URL,
          headers: { Authorization: FREIGHTCOM_API_KEY },
        });

        const rateData = {
          details: {
            origin: {
              address: {
                country: 'CA',
                postal_code: originPostalCode,
              },
            },
            destination: {
              address: {
                country: 'CA',
                postal_code: destinationPostalCode,
              },
              ready_at: { hour: 15, minute: 6 },
              ready_until: { hour: 15, minute: 6 },
              signature_requirement: 'not-required',
            },
            expected_ship_date: {
              year: Number(year),
              month: Number(month),
              day: Number(day),
            },
            packaging_type: 'pallet',
            packaging_properties: {
              pallet_type: 'ltl',
              pallets: items,
            },
          },
        };

        console.log(`[${cartId}] Sending rate request to FreightCom API...`);
        const rateResponse = await client.post('/rate', rateData);
        const rateId = rateResponse.data.request_id;
        console.log(`[${cartId}] Received rate ID: ${rateId}`);

        // Poll for rates
        console.log(`[${cartId}] Polling for rates (max 30 attempts)...`);
        const rates = await new Promise<any[]>((resolve) => {
          let attempts = 0;
          const maxAttempts = 30;
          const timer = setInterval(async () => {
            attempts++;
            try {
              const response = (await client.get(`/rate/${rateId}`)).data;
              if (response.status?.done) {
                clearInterval(timer);
                const ratesArray = response.rates || [];
                console.log(`[${cartId}] Rates ready! Received ${ratesArray.length} rates`);
                resolve(ratesArray);
              } else if (attempts >= maxAttempts) {
                clearInterval(timer);
                console.log(`[${cartId}] Timeout after ${maxAttempts} attempts`);
                resolve([]);
              }
            } catch (error: any) {
              clearInterval(timer);
              console.log(`[${cartId}] Error polling rates: ${error.message}`);
              resolve([]);
            }
          }, 1000);
        });

        if (rates.length === 0) {
          throw new Error('No rates returned from FreightCom API');
        }

        const rate = rates[0];
        if (!rate?.total?.value) {
          throw new Error('Invalid rate response from FreightCom API');
        }

        // Convert from cents to dollars and apply multiplier
        const freightComPriceInCents = Number(rate.total.value);
        FreightComPrice = Math.floor(freightComPriceInCents * 1.15) / 100;

        // Apply FreightCom discount if configured
        const freightComDiscountSettings = await strapiInstance
          .service('api::medusa-discount-settings.medusa-discount-setting')
          .find();
        if (freightComDiscountSettings?.isDiscountEnabled && freightComDiscountSettings?.discountPercentage) {
          freightComDiscountPercent = freightComDiscountSettings.discountPercentage;
          const discountAmount = FreightComPrice * (freightComDiscountPercent / 100);
          FreightComPrice = Math.max(0, FreightComPrice - discountAmount);
        }
      } catch (freightComError: any) {
        console.error(`[${cartId}] FreightCom API error: ${freightComError.message}`);
        if (freightComError.response) {
          console.error(`[${cartId}] FreightCom API response status: ${freightComError.response.status}`);
          console.error(`[${cartId}] FreightCom API response data:`, JSON.stringify(freightComError.response.data, null, 2));
        }
        console.log(`[${cartId}] Falling back to FreightCom calculation`);
      }

      // Get Strapi calculation result
      const strapiResult = await fulfillmentService.calculateShipping(cart);

      if (!strapiResult.boxes || !Array.isArray(strapiResult.boxes)) {
        throw new Error('Expected boxes format from Strapi service');
      }

      // Return FreightCom result if successful, otherwise Strapi result
      if (FreightComPrice !== null) {
        ctx.body = {
          destination: strapiResult.destination,
          chosenWarehouse: strapiResult.chosenWarehouse,
          distanceKm: strapiResult.distanceKm,
          subtotal: parseFloat(FreightComPrice.toFixed(3)),
          source: 'FreightCom_API',
          discountPercent: freightComDiscountPercent,
          total: parseFloat(FreightComPrice.toFixed(3)),
          currency: 'CAD',
        };
      } else {
        ctx.body = {
          ...strapiResult,
          source: 'STRAPI_TABLE',
        };
      }
    } catch (error: any) {
      console.error(`[${cartId}] Error calculating shipping: ${error.message}`);
      ctx.throw(500, error.message || 'Error calculating shipping');
    }
  },
};
