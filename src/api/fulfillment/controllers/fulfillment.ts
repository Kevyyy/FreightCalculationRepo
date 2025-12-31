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
            return ctx.badRequest(`Box ${i + 1} is missing required fields: length, width, height, and weight are required`);
          }
        }
      }

      if (!cart.shipping_address) {
        return ctx.badRequest('Shipping address is required');
      }

      if (!cart.shipping_address.postal_code) {
        return ctx.badRequest('Shipping address postal_code is required');
      }

      const strapiInstance = ctx.state?.strapi || (global as any).strapi;
      if (!strapiInstance) {
        throw new Error('Strapi instance not available');
      }

      const destinationPostalCode = cart.shipping_address?.postal_code;

      const SALES_CHANNEL_POSTAL_CODES: Record<string, string> = {
        'sc_01GY1TR8XSSA865FXVJDQR9XCZ': 'H2K 4P5',
        'sc_01H54KV0V84HGG6PZD06T3J8C4': 'L0L 1P0',
        'sc_01H54KTSHXG7TYSRN9XND4HHQB': 'J3E 0C4',
      };

      let originPostalCode: string;
      if (cart.warehouse_id) {
        const warehouse = await strapiInstance.documents('api::warehouse.warehouse').findOne({
          documentId: typeof cart.warehouse_id === 'string' ? parseInt(cart.warehouse_id) : cart.warehouse_id,
        });
        if (warehouse && warehouse.postalCode) {
          originPostalCode = warehouse.postalCode;
        } else {
          originPostalCode = SALES_CHANNEL_POSTAL_CODES[cart.sales_channel_id || ''] || Object.values(SALES_CHANNEL_POSTAL_CODES)[0];
        }
      } else if (cart.sales_channel_id && SALES_CHANNEL_POSTAL_CODES[cart.sales_channel_id]) {
        originPostalCode = SALES_CHANNEL_POSTAL_CODES[cart.sales_channel_id];
      } else {
        const fulfillmentServiceFactory = require('../services/fulfillment').default;
        const fulfillmentService = fulfillmentServiceFactory({ strapi: strapiInstance });
        originPostalCode = await fulfillmentService.getOriginPostalCode(
          cart.sales_channel_id,
          destinationPostalCode,
          cart.warehouse_id
        );
      }

      let medusaPrice: number | null = null;
      let medusaDiscountPercent = 0;

      try {
        const axios = require('axios');
        const FREIGHTCOM_API_KEY = process.env.FREIGHTCOM_API_KEY;
        const MEDUSA_BASE_URL = process.env.MEDUSA_BASE_URL || 'https://external-api.freightcom.com';

        if (!FREIGHTCOM_API_KEY) {
          throw new Error('FREIGHTCOM_API_KEY not configured in environment variables');
        }

        const items = [];
        if (cart.boxes && Array.isArray(cart.boxes)) {
          for (const box of cart.boxes) {
            items.push({
              measurements: {
                weight: { unit: 'g', value: box.weight },
                cuboid: {
                  unit: 'mm',
                  l: box.length,
                  w: box.width,
                  h: box.height,
                },
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
                  weight: { unit: 'g', value: product.weight || 0 },
                  cuboid: {
                    unit: 'mm',
                    l: product.length || 0,
                    w: product.width || 0,
                    h: product.height || 0,
                  },
                },
                description: 'string',
                freight_class: 'string',
              });
            }
          }
        }

        const deliveryDate = new Date();
        deliveryDate.setDate(deliveryDate.getDate() + 7);
        const day = String(deliveryDate.getDate()).padStart(2, '0');
        const month = String(deliveryDate.getMonth() + 1).padStart(2, '0');
        const year = deliveryDate.getFullYear();

        const client = axios.create({
          baseURL: MEDUSA_BASE_URL,
          headers: {
            Authorization: FREIGHTCOM_API_KEY,
          },
        });

        const servicesResponse = await client.get('/services');
        const availableServices = servicesResponse.data;

        if (!availableServices || availableServices.length === 0) {
          throw new Error('No services available from Medusa API');
        }

        const ltlServices = availableServices.filter((s: any) => 
          s.id.includes('.standard') && !s.id.includes('rail')
        );
        
        const priorityCarriers = ['purolatorfreight', 'freightcom', 'dayross', 'tforce', 'abf', 'versacold', 'one'];
        const priorityServices = ltlServices.filter((s: any) => 
          priorityCarriers.some(carrier => s.id.includes(carrier))
        );
        
        const otherServices = ltlServices.filter((s: any) => 
          !priorityServices.some(ps => ps.id === s.id)
        );
        const allServicesToTry = [...priorityServices, ...otherServices];
        
        const batchSize = 50;
        const servicesToTry = allServicesToTry.length > 0 
          ? allServicesToTry.slice(0, batchSize) 
          : availableServices.slice(0, batchSize);
        const serviceIds = servicesToTry.map((s: any) => s.id);

        const rateData = {
          services: serviceIds,
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

        const rateResponse = await client.post('/rate', rateData);
        const rateId = rateResponse.data.request_id;

        const rates = await new Promise((resolve) => {
          let attempts = 0;
          const maxAttempts = 30;
          const timer = setInterval(async () => {
            attempts++;
            try {
              const response = (await client.get('/rate/' + rateId)).data;
              if (response.status.done) {
                clearInterval(timer);
                resolve(response.rates || []);
              } else if (attempts >= maxAttempts) {
                clearInterval(timer);
                resolve([]);
              }
            } catch (error: any) {
              clearInterval(timer);
              resolve([]);
            }
          }, 1000);
        }) as any[];

        if (rates.length === 0) {
          throw new Error(`No rates found from Medusa API after trying ${serviceIds.length} services`);
        }

        const rate = rates[0];

        if (!rate) {
          throw new Error('No rate found from Medusa API');
        }

        const medusaPriceInCents = Number(rate.total.value);
        medusaPrice = Math.floor(medusaPriceInCents * 1.15) / 100;

        const medusaDiscountSettings = await strapiInstance.service('api::medusa-discount-settings.medusa-discount-setting').find();
        if (medusaDiscountSettings?.isDiscountEnabled && medusaDiscountSettings?.discountPercentage) {
          medusaDiscountPercent = medusaDiscountSettings.discountPercentage;
          const discountAmount = medusaPrice * (medusaDiscountPercent / 100);
          medusaPrice = Math.max(0, medusaPrice - discountAmount);
        }
      } catch (medusaError: any) {
        // Silently fall back to Strapi calculation
      }

      const fulfillmentServiceFactory = require('../services/fulfillment').default;
      const fulfillmentService = fulfillmentServiceFactory({ strapi: strapiInstance });
      const strapiResult = await fulfillmentService.calculateShipping(cart);

      if (!strapiResult.boxes || !Array.isArray(strapiResult.boxes)) {
        throw new Error('Expected boxes format from Strapi service');
      }

      if (medusaPrice !== null) {
        ctx.body = {
          destination: strapiResult.destination,
          chosenWarehouse: strapiResult.chosenWarehouse,
          distanceKm: strapiResult.distanceKm,
          subtotal: parseFloat(medusaPrice.toFixed(3)),
          source: 'MEDUSA_API',
          discountPercent: medusaDiscountPercent,
          total: parseFloat(medusaPrice.toFixed(3)),
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
