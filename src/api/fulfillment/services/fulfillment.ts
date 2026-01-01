/**
 * fulfillment service.
 */

export default ({ strapi }: { strapi: any }) => ({
  /**
   * Calculate distance using Google Distance Matrix API
   * Returns distance in kilometers
   */
  async calculateDistance(
    originAddress: string,
    destinationAddress: string
  ): Promise<number> {
    try {
      const axios = require('axios');
      const qs = require('qs');
      const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

      if (!GOOGLE_API_KEY) {
        throw new Error('GOOGLE_API_KEY environment variable is not set');
      }

      type DistanceMatrix = {
        destination_addresses: string[];
        origin_addresses: string[];
        rows: {
          elements: {
            distance: {
              text: string;
              value: number;
            };
            duration: {
              text: string;
              value: number;
            };
            status: string;
          }[];
        }[];
      };

      const queryData = {
        origins: originAddress,
        destinations: destinationAddress,
        key: GOOGLE_API_KEY,
      };

      const response = await axios.get(
        `https://maps.googleapis.com/maps/api/distancematrix/json?${qs.stringify(queryData)}`
      );

      const distanceMatrix = response.data as DistanceMatrix;

      if (distanceMatrix.rows.length === 0) {
        throw new Error('No distance matrix rows returned');
      }

      const { elements } = distanceMatrix.rows[0];
      const element = elements[0];

      if (!element || element.status !== 'OK') {
        throw new Error(`Distance Matrix API error: ${element?.status || 'No element returned'}`);
      }

      // Distance Matrix API returns distance in meters, convert to kilometers
      const distanceMeters = element.distance.value;
      return distanceMeters / 1000;
    } catch (error: any) {
      throw new Error(`Failed to calculate distance: ${error.message}`);
    }
  },

  /**
   * Map distance in kilometers to distance range string used in pricing
   * Database uses kilometer ranges (e.g., "0-99km", "100-199km")
   */
  mapDistanceToRange(distanceKm: number): string {
    if (distanceKm < 100) return '0-99km';
    if (distanceKm < 200) return '100-199km';
    if (distanceKm < 300) return '200-299km';
    if (distanceKm < 400) return '300-399km';
    if (distanceKm < 500) return '400-499km';
    if (distanceKm < 600) return '500-599km';
    if (distanceKm < 700) return '600-699km';
    if (distanceKm < 800) return '700-799km';
    if (distanceKm < 900) return '800-899km';
    if (distanceKm < 1000) return '900-999km';
    return '1000+km';
  },

  /**
   * Convert millimeters to inches
   */
  mmToInches(mm: number): number {
    return mm * 0.0393701;
  },

  /**
   * Convert grams to pounds
   */
  gramsToPounds(grams: number): number {
    return grams * 0.00220462;
  },

  /**
   * Calculate density (PCF - Pounds per Cubic Foot)
   * Formula: Weight / Volume
   * Note: Input dimensions are in mm, weight in grams (from Medusa)
   * We convert to inches and pounds for density calculation
   */
  calculateDensity(lengthMm: number, widthMm: number, heightMm: number, weightGrams: number): number {
    if (weightGrams <= 0) return 0;
    
    const lengthInches = this.mmToInches(lengthMm);
    const widthInches = this.mmToInches(widthMm);
    const heightInches = this.mmToInches(heightMm);
    const weightPounds = this.gramsToPounds(weightGrams);
    const cubicFeet = (lengthInches * widthInches * heightInches) / 1728;
    
    return weightPounds / cubicFeet;
  },

  /**
   * Find freight class based on density
   */
  async findFreightClassByDensity(density: number): Promise<number | null> {
    const calculations = await strapi.documents('api::freight-calculation.freight-calculation').findMany({
      filters: {},
    });

    // Sort by sub (ascending) to check ranges in order
    const sorted = calculations.sort((a: any, b: any) => a.sub - b.sub);

    // Map density ranges to freight classes
    // Based on the seed data structure
    for (const calc of sorted) {
      const range = calc.densityRange;
      
      if (range === 'Less than 1' && density < 1) {
        return calc.assignedFreightClass;
      } else if (range.includes('but less than')) {
        const parts = range.split('but less than');
        const min = parseFloat(parts[0].trim());
        const max = parseFloat(parts[1].trim());
        if (density >= min && density < max) {
          return calc.assignedFreightClass;
        }
      } else if (range === '50 or greater' && density >= 50) {
        return calc.assignedFreightClass;
      }
    }

    // Default to highest class if density is very low
    return sorted[sorted.length - 1]?.assignedFreightClass || null;
  },

  /**
   * Calculate cubic feet from dimensions in mm
   */
  calculateCubicFeet(lengthMm: number, widthMm: number, heightMm: number): number {
    const lengthInches = this.mmToInches(lengthMm);
    const widthInches = this.mmToInches(widthMm);
    const heightInches = this.mmToInches(heightMm);
    return (lengthInches * widthInches * heightInches) / 1728;
  },

  /**
   * Find price and rate per CWT based on freight class, distance, and weight
   */
  async findPriceAndRateByClassAndDistance(
    freightClass: number,
    distance: string,
    weight: number
  ): Promise<{ price: number; ratePerCwt: number } | null> {
    const freightClassInt = Math.round(freightClass);
    
    let pricings = await strapi.documents('api::freight-class-pricing.freight-class-pricing').findMany({
      filters: {
        freightClass: freightClassInt,
        distance: distance,
      },
    });

    if (pricings.length === 0 && distance.includes('-')) {
      const rangeStart = distance.split('-')[0].trim();
      const allPricings = await strapi.documents('api::freight-class-pricing.freight-class-pricing').findMany({
        filters: {
          freightClass: freightClassInt,
        },
      });
      pricings = allPricings.filter((p: any) => {
        const pDistance = p.distance?.toString() || '';
        return pDistance === distance || pDistance.startsWith(rangeStart) || pDistance === rangeStart;
      });
    }

    if (pricings.length === 0) {
      pricings = await strapi.documents('api::freight-class-pricing.freight-class-pricing').findMany({
        filters: {
          freightClass: freightClassInt,
        },
      });
    }

    if (pricings.length === 0) {
      return null;
    }

    const sorted = pricings
      .filter((p: any) => p.breakpointValue !== null && p.breakpointValue !== undefined)
      .sort((a: any, b: any) => a.breakpointValue - b.breakpointValue);

    let selectedPricing = null;
    
    for (let i = 0; i < sorted.length; i++) {
      const current = sorted[i];
      const next = sorted[i + 1];
      
      if (weight >= current.breakpointValue && (!next || weight < next.breakpointValue)) {
        selectedPricing = current;
        break;
      }
    }

    if (!selectedPricing && sorted.length > 0) {
      selectedPricing = sorted[sorted.length - 1];
    }

    if (!selectedPricing) {
      const catchAll = pricings.find((p: any) => !p.breakpointValue);
      if (catchAll) {
        selectedPricing = catchAll;
      }
    }

    if (!selectedPricing) {
      return null;
    }

    const ratePerCwt = parseFloat(selectedPricing.price);
    const totalPrice = ratePerCwt * (weight / 100);

    return {
      price: totalPrice,
      ratePerCwt: ratePerCwt,
    };
  },

  /**
   * Find price based on freight class, distance, and weight
   */
  async findPriceByClassAndDistance(
    freightClass: number,
    distance: string,
    weight: number
  ): Promise<number | null> {
    // Try to find pricing - handle both exact match and range matching
    // Round freight class to integer for matching (stored as integer in DB)
    const freightClassInt = Math.round(freightClass);
    
    // First try exact distance match
    let pricings = await strapi.documents('api::freight-class-pricing.freight-class-pricing').findMany({
      filters: {
        freightClass: freightClassInt,
        distance: distance,
      },
    });

    // If no exact match, try to find by distance range
    // Distance might be stored as a number (e.g., "0") or range (e.g., "0-499")
    if (pricings.length === 0 && distance.includes('-')) {
      // Extract the start of the range (e.g., "0-499" -> "0")
      const rangeStart = distance.split('-')[0].trim();
      // Try matching distance that starts with the range start
      const allPricings = await strapi.documents('api::freight-class-pricing.freight-class-pricing').findMany({
        filters: {
          freightClass: freightClassInt,
        },
      });
      pricings = allPricings.filter((p: any) => {
        const pDistance = p.distance?.toString() || '';
        return pDistance === distance || pDistance.startsWith(rangeStart) || pDistance === rangeStart;
      });
    }

    // If still no match, try without distance filter (just by freight class)
    if (pricings.length === 0) {
      pricings = await strapi.documents('api::freight-class-pricing.freight-class-pricing').findMany({
        filters: {
          freightClass: freightClassInt,
        },
      });
    }

    if (pricings.length === 0) {
      return null;
    }

    // Find the appropriate weight breakpoint
    // Sort by breakpointValue (ascending) to find the right range
    const sorted = pricings
      .filter((p: any) => p.breakpointValue !== null && p.breakpointValue !== undefined)
      .sort((a: any, b: any) => a.breakpointValue - b.breakpointValue);

    // Find the breakpoint that matches the weight
    let selectedPricing = null;
    
    for (let i = 0; i < sorted.length; i++) {
      const current = sorted[i];
      const next = sorted[i + 1];
      
      if (weight >= current.breakpointValue && (!next || weight < next.breakpointValue)) {
        selectedPricing = current;
        break;
      }
    }

    // If no breakpoint found, use the highest one (weight exceeds all breakpoints)
    if (!selectedPricing && sorted.length > 0) {
      selectedPricing = sorted[sorted.length - 1];
    }

    // If still no pricing found, try to find one without breakpoint value (catch-all)
    if (!selectedPricing) {
      const catchAll = pricings.find((p: any) => !p.breakpointValue);
      if (catchAll) {
        selectedPricing = catchAll;
      }
    }

    // Price in DB is per 100 lbs (CWT - hundredweight)
    // Calculate total price: price per 100 lbs × (weight / 100)
    if (selectedPricing) {
      const pricePer100Lbs = parseFloat(selectedPricing.price);
      const totalPrice = pricePer100Lbs * (weight / 100);
      return totalPrice;
    }

    return null;
  },

  /**
   * Get origin postal code from warehouse database
   * Priority: sales_channel_id > warehouse_id > closest warehouse
   */
  async getOriginPostalCode(
    salesChannelId: string | null | undefined,
    destinationPostalCode?: string,
    warehouseId?: number | string
  ): Promise<string> {
    try {
      if (warehouseId) {
        const warehouse = await strapi.documents('api::warehouse.warehouse').findOne({
          documentId: typeof warehouseId === 'string' ? parseInt(warehouseId) : warehouseId,
        });

        if (warehouse && warehouse.postalCode) {
          return warehouse.postalCode;
        }
      }

      if (salesChannelId) {
        const warehouses = await strapi.documents('api::warehouse.warehouse').findMany({
          filters: {
            salesChannelId: salesChannelId,
          },
        });

        if (warehouses && warehouses.length > 0) {
          return warehouses[0].postalCode;
        }
      }

      if (destinationPostalCode) {
        const allWarehouses = await strapi.documents('api::warehouse.warehouse').findMany({
          filters: {},
        });

        if (allWarehouses && allWarehouses.length > 0) {
          if (allWarehouses.length === 1) {
            return allWarehouses[0].postalCode;
          }

          const destAddress = `${destinationPostalCode} CA`;

          let closestWarehouse = allWarehouses[0];
          let minDistance = Infinity;

          for (const warehouse of allWarehouses) {
            if (!warehouse.postalCode) continue;

            const originAddress = `${warehouse.postalCode} CA`;

            try {
              const distance = await this.calculateDistance(originAddress, destAddress);

              if (distance < minDistance) {
                minDistance = distance;
                closestWarehouse = warehouse;
              }
            } catch (error) {
              continue;
            }
          }

          return closestWarehouse.postalCode;
        }
      }
      const allWarehouses = await strapi.documents('api::warehouse.warehouse').findMany({
        filters: {},
      });

      if (allWarehouses && allWarehouses.length > 0) {
        return allWarehouses[0].postalCode;
      }

      // Throw error if no warehouses exist
      throw new Error('No warehouses found in database. Please add at least one warehouse.');
    } catch (error) {
      throw new Error(`Failed to get origin postal code: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  },


  /**
   * Calculate shipping price for items or boxes
   * Supports two modes:
   * 1. boxes: Array of boxes with individual dimensions (each calculated separately)
   * 2. items: Array of items (backward compatible, uses max dimensions)
   */
  async calculateShipping(cart: {
    id?: string;
    sales_channel_id?: string;
    warehouse_id?: number | string;
    items?: Array<{
      quantity: number;
      variant?: {
        length?: number;
        width?: number;
        height?: number;
        weight?: number;
      };
      product?: {
        length?: number;
        width?: number;
        height?: number;
        weight?: number;
      };
      length?: number;
      width?: number;
      height?: number;
      weight?: number;
    }>;
    boxes?: Array<{
      length: number;
      width: number;
      height: number;
      weight: number;
    }>;
    shipping_address: {
      postal_code: string;
      country_code?: string;
    };
  }): Promise<any> {
    const destinationPostalCode = cart.shipping_address.postal_code;

    if (!destinationPostalCode) {
      throw new Error('Missing destination postal code');
    }

    const originPostalCode = await this.getOriginPostalCode(
      cart.sales_channel_id,
      destinationPostalCode,
      cart.warehouse_id
    );

    if (!destinationPostalCode) {
      throw new Error('Missing destination postal code');
    }

    const originAddress = `${originPostalCode} CA`;
    const destinationAddress = `${destinationPostalCode} CA`;

    const distanceKm = await this.calculateDistance(originAddress, destinationAddress);
    const distanceRange = this.mapDistanceToRange(distanceKm);

    if (cart.boxes && Array.isArray(cart.boxes) && cart.boxes.length > 0) {
      const destinationCountry = cart.shipping_address.country_code || 'CA';
      return await this.calculateShippingForBoxes(
        cart.boxes,
        distanceKm,
        distanceRange,
        originPostalCode,
        destinationPostalCode,
        destinationCountry
      );
    }

    if (!cart.items || !Array.isArray(cart.items) || cart.items.length === 0) {
      throw new Error('Either items or boxes array is required');
    }

    const boxes: Array<{
      length: number;
      width: number;
      height: number;
      weight: number;
    }> = [];

    for (const item of cart.items) {
      const quantity = item.quantity || 1;
      
      const length = item.length || item.variant?.length || item.product?.length || 0;
      const width = item.width || item.variant?.width || item.product?.width || 0;
      const height = item.height || item.variant?.height || item.product?.height || 0;
      const weight = item.weight || item.variant?.weight || item.product?.weight || 0;

      if (!length || !width || !height || !weight) {
        throw new Error(`Item missing dimensions or weight. Each item must have length, width, height, and weight.`);
      }

      for (let i = 0; i < quantity; i++) {
        boxes.push({
          length: length,
          width: width,
          height: height,
          weight: weight,
        });
      }
    }

    const destinationCountry = cart.shipping_address.country_code || 'CA';
    return await this.calculateShippingForBoxes(
      boxes,
      distanceKm,
      distanceRange,
      originPostalCode,
      destinationPostalCode,
      destinationCountry
    );
  },

  /**
   * Calculate shipping for multiple boxes (each box calculated separately)
   * Returns format matching the exact structure requested
   */
  async calculateShippingForBoxes(
    boxes: Array<{
      length: number;
      width: number;
      height: number;
      weight: number;
    }>,
    distanceKm: number,
    distanceRange: string,
    originPostalCode: string,
    destinationPostalCode: string,
    destinationCountry: string = 'CA'
  ): Promise<{
    destination: {
      postalCode: string;
      country: string;
    };
    chosenWarehouse: {
      id: number;
      name: string;
      postalCode: string;
    };
    distanceKm: number;
    boxes: Array<{
      weightLbs: number;
      cubicFeet: number;
      densityPcf: number;
      freightClass: number;
      distanceKm: number;
      rateSource: string;
      ratePerCwt: number;
      currency: string;
      price: number;
      dimensionsIn: {
        lengthIn: number;
        widthIn: number;
        heightIn: number;
      };
    }>;
    subtotal: number;
    discountPercent: number;
    total: number;
    currency: string;
  }> {
    // Get warehouse information
    const warehouses = await strapi.documents('api::warehouse.warehouse').findMany({
      filters: {
        postalCode: originPostalCode,
      },
    });

    const warehouse = warehouses && warehouses.length > 0 ? warehouses[0] : null;

    const boxResults: Array<{
      weightLbs: number;
      cubicFeet: number;
      densityPcf: number;
      freightClass: number;
      distanceKm: number;
      rateSource: string;
      ratePerCwt: number;
      currency: string;
      price: number;
      dimensionsIn: {
        lengthIn: number;
        widthIn: number;
        heightIn: number;
      };
    }> = [];

    let subtotal = 0;

    for (const box of boxes) {
      if (!box.length || !box.width || !box.height || !box.weight) {
        throw new Error(`Box missing dimensions or weight. Each box must have length, width, height, and weight.`);
      }

      const lengthInches = this.mmToInches(box.length);
      const widthInches = this.mmToInches(box.width);
      const heightInches = this.mmToInches(box.height);
      const cubicFeet = this.calculateCubicFeet(box.length, box.width, box.height);
      const density = this.calculateDensity(box.length, box.width, box.height, box.weight);
      const weightPounds = this.gramsToPounds(box.weight);

      const calculatedFreightClass = await this.findFreightClassByDensity(density);
      if (!calculatedFreightClass) {
        throw new Error(`Could not determine freight class for box with density: ${density.toFixed(2)} PCF`);
      }

      let freightClassUsed = calculatedFreightClass;
      let priceResult = await this.findPriceAndRateByClassAndDistance(calculatedFreightClass, distanceRange, weightPounds);
      
      if (priceResult === null && calculatedFreightClass % 1 !== 0) {
        const roundedClass = Math.round(calculatedFreightClass);
        priceResult = await this.findPriceAndRateByClassAndDistance(roundedClass, distanceRange, weightPounds);
        if (priceResult !== null) {
          freightClassUsed = roundedClass;
        }
      }

      if (priceResult === null) {
        const allPricings = await strapi.documents('api::freight-class-pricing.freight-class-pricing').findMany({
          filters: {},
        });
        const availableClasses: number[] = [...new Set(allPricings.map((p: any) => Number(p.freightClass)))].filter((c: any): c is number => !isNaN(c) && typeof c === 'number').sort((a: number, b: number) => a - b);
        
        if (availableClasses.length === 0) {
          throw new Error('No freight class pricing data found in database. Please run the seed script first.');
        }

        let nearestClass: number = availableClasses[0];
        let minDiff = Math.abs(calculatedFreightClass - nearestClass);
        
        for (const availableClass of availableClasses) {
          const diff = Math.abs(calculatedFreightClass - availableClass);
          if (diff < minDiff) {
            minDiff = diff;
            nearestClass = availableClass;
          }
        }

        priceResult = await this.findPriceAndRateByClassAndDistance(nearestClass, distanceRange, weightPounds);
        
        if (priceResult === null) {
          throw new Error(
            `Could not find pricing for box with freight class: ${calculatedFreightClass} (tried nearest: ${nearestClass}), ` +
            `distance: ${distanceKm.toFixed(2)} km (range: ${distanceRange}), weight: ${weightPounds.toFixed(2)} lbs.`
          );
        }
        
        freightClassUsed = nearestClass;
      }

      boxResults.push({
        weightLbs: parseFloat(weightPounds.toFixed(2)),
        cubicFeet: parseFloat(cubicFeet.toFixed(14)),
        densityPcf: parseFloat(density.toFixed(14)),
        freightClass: freightClassUsed,
        distanceKm: parseFloat(distanceKm.toFixed(3)),
        rateSource: 'STRAPI_TABLE',
        ratePerCwt: parseFloat(priceResult.ratePerCwt.toFixed(1)),
        currency: 'CAD',
        price: parseFloat(priceResult.price.toFixed(2)),
        dimensionsIn: {
          lengthIn: parseFloat(lengthInches.toFixed(2)),
          widthIn: parseFloat(widthInches.toFixed(2)),
          heightIn: parseFloat(heightInches.toFixed(2)),
        },
      });

      subtotal += priceResult.price;
    }

    // Apply discount to total price
    const settings = await strapi.service('api::discount-settings.discount-setting').find();
    const discountPercent = settings?.isDiscountEnabled && settings?.discountPercentage ? settings.discountPercentage : 0;
    const discountAmount = subtotal * (discountPercent / 100);
    const total = parseFloat((subtotal - discountAmount).toFixed(3));

    return {
      destination: {
        postalCode: destinationPostalCode,
        country: destinationCountry,
      },
      chosenWarehouse: {
        id: warehouse?.documentId || 0,
        name: warehouse?.name || 'Unknown Warehouse',
        postalCode: originPostalCode,
      },
      distanceKm: parseFloat(distanceKm.toFixed(3)),
      boxes: boxResults,
      subtotal: parseFloat(subtotal.toFixed(3)),
      discountPercent: discountPercent,
      total: total,
      currency: 'CAD',
    };
  },
});

