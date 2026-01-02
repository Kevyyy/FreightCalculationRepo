/**
 * Fulfillment service for calculating shipping rates
 * Supports both FreightCom API integration and internal Strapi-based calculations
 */

import axios from 'axios';
import qs from 'qs';

interface Box {
  length: number;
  width: number;
  height: number;
  weight: number;
}

interface PricingResult {
  price: number;
  ratePerCwt: number;
}

interface DistanceMatrixResponse {
  destination_addresses: string[];
  origin_addresses: string[];
  rows: {
    elements: {
      distance: { text: string; value: number };
      duration: { text: string; value: number };
      status: string;
    }[];
  }[];
}

export default ({ strapi }: { strapi: any }) => ({
  /**
   * Calculate distance using Google Distance Matrix API
   * @returns Distance in kilometers
   */
  async calculateDistance(originAddress: string, destinationAddress: string): Promise<number> {
    const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
    if (!GOOGLE_API_KEY) {
      throw new Error('GOOGLE_API_KEY environment variable is not set');
    }

    const queryData = {
      origins: originAddress,
      destinations: destinationAddress,
      key: GOOGLE_API_KEY,
    };

    try {
      const response = await axios.get<DistanceMatrixResponse>(
        `https://maps.googleapis.com/maps/api/distancematrix/json?${qs.stringify(queryData)}`
      );

      const { rows } = response.data;
      if (!rows.length || !rows[0].elements.length) {
        throw new Error('No distance matrix rows returned');
      }

      const element = rows[0].elements[0];
      if (element.status !== 'OK') {
        throw new Error(`Distance Matrix API error: ${element.status}`);
      }

      return element.distance.value / 1000;
    } catch (error: any) {
      throw new Error(`Failed to calculate distance: ${error.message}`);
    }
  },

  /**
   * Map distance in kilometers to distance range string used in pricing
   */
  mapDistanceToRange(distanceKm: number): string {
    const ranges: [number, number, string][] = [
      [0, 100, '0-99km'],
      [100, 200, '100-200km'],
      [200, 300, '200-300'],
      [300, 400, '300-400'],
      [400, 500, '400-500'],
      [500, 700, '500-700'],
      [700, 1000, '700-1000'],
    ];

    for (const [min, max, range] of ranges) {
      if (distanceKm >= min && distanceKm < max) {
        return range;
      }
    }
    return '1000-1500+';
  },

  /**
   * Find freight class based on density (PCF)
   */
  async findFreightClassByDensity(density: number): Promise<number | null> {
    const calculations = await strapi.documents('api::freight-calculation.freight-calculation').findMany({
      filters: {},
    });

    const sorted = calculations.sort((a: any, b: any) => a.sub - b.sub);

    for (const calc of sorted) {
      const range = calc.densityRange;

      if (range === 'Less than 1' && density < 1) {
        return calc.assignedFreightClass;
      }

      if (range.includes('but less than')) {
        const [minStr, maxStr] = range.split('but less than');
        const min = parseFloat(minStr.trim());
        const max = parseFloat(maxStr.trim());
        if (density >= min && density < max) {
          return calc.assignedFreightClass;
        }
      }

      if (range === '50 or greater' && density >= 50) {
        return calc.assignedFreightClass;
      }
    }

    return sorted[sorted.length - 1]?.assignedFreightClass || null;
  },

  /**
   * Calculate cubic feet from dimensions in inches
   */
  calculateCubicFeet(lengthIn: number, widthIn: number, heightIn: number): number {
    return (lengthIn * widthIn * heightIn) / 1728;
  },

  /**
   * Calculate density (PCF - Pounds per Cubic Foot)
   */
  calculateDensity(lengthIn: number, widthIn: number, heightIn: number, weightLb: number): number {
    if (weightLb <= 0) return 0;
    return weightLb / this.calculateCubicFeet(lengthIn, widthIn, heightIn);
  },

  /**
   * Find pricing entries by freight class and distance
   * Handles exact matches, range matches, and fallback to freight class only
   */
  async findPricingEntries(freightClass: number, distance: string): Promise<any[]> {
    const freightClassInt = Math.round(freightClass);

    let pricings = await strapi.documents('api::freight-class-pricing.freight-class-pricing').findMany({
      filters: { freightClass: freightClassInt, distance },
    });

    if (pricings.length === 0 && distance.includes('-')) {
      const rangeStart = distance.split('-')[0].trim();
      const allPricings = await strapi.documents('api::freight-class-pricing.freight-class-pricing').findMany({
        filters: { freightClass: freightClassInt },
      });
      pricings = allPricings.filter((p: any) => {
        const pDistance = p.distance?.toString() || '';
        return pDistance === distance || pDistance.startsWith(rangeStart) || pDistance === rangeStart;
      });
    }

    if (pricings.length === 0) {
      pricings = await strapi.documents('api::freight-class-pricing.freight-class-pricing').findMany({
        filters: { freightClass: freightClassInt },
      });
    }

    return pricings;
  },

  /**
   * Parse weight breakpoint string to check if weight matches
   * Handles formats like "1000-1500", "999 kg" (actually lbs, label is wrong), "1500-2000", etc.
   * All weights in database are in lbs - ignore "kg" labels as they are incorrect
   * Uses exclusive upper bound (<) to handle overlapping breakpoints correctly
   */
  matchesWeightBreakpoint(weightBreakpoint: string, weight: number): boolean {
    if (!weightBreakpoint) return false;
    
    const wbp = weightBreakpoint.trim().toLowerCase();
    
    const rangeMatch = wbp.match(/^(\d+)\s*-\s*(\d+)/);
    if (rangeMatch) {
      const min = parseFloat(rangeMatch[1]);
      const max = parseFloat(rangeMatch[2]);
      return weight >= min && weight < max;
    }
    
    const singleValueMatch = wbp.match(/^(\d+)\s*(kg|lb|lbs)?/);
    if (singleValueMatch) {
      const value = parseFloat(singleValueMatch[1]);
      return weight < value;
    }
    
    const plusMatch = wbp.match(/^(\d+)\+$/);
    if (plusMatch) {
      const min = parseFloat(plusMatch[1]);
      return weight >= min;
    }
    
    return false;
  },

  selectPricingByWeight(pricings: any[], weight: number): any | null {
    const sorted = pricings
      .filter((p) => p.breakpointValue != null)
      .sort((a, b) => a.breakpointValue - b.breakpointValue);

    for (let i = 0; i < sorted.length; i++) {
      const current = sorted[i];
      const next = sorted[i + 1];
      if (weight >= current.breakpointValue && (!next || weight < next.breakpointValue)) {
        return current;
      }
    }

    if (sorted.length > 0) {
      return sorted[sorted.length - 1];
    }

    const withoutBreakpoint = pricings.filter((p) => !p.breakpointValue);
    for (const pricing of withoutBreakpoint) {
      const weightBreakpoint = pricing.weightBreakpoint || pricing.weight_breakpoint;
      if (this.matchesWeightBreakpoint(weightBreakpoint, weight)) {
        return pricing;
      }
    }

    return withoutBreakpoint[0] || null;
  },

  /**
   * Find price and rate per CWT based on freight class, distance, and weight
   */
  async findPriceAndRateByClassAndDistance(
    freightClass: number,
    distance: string,
    weight: number
  ): Promise<PricingResult | null> {
    const pricings = await this.findPricingEntries(freightClass, distance);
    if (pricings.length === 0) {
      return null;
    }

    const selectedPricing = this.selectPricingByWeight(pricings, weight);
    if (!selectedPricing) {
      return null;
    }

    const ratePerCwt = parseFloat(selectedPricing.price);
    const price = ratePerCwt * (weight / 100);

    return { price, ratePerCwt };
  },

  /**
   * Get all warehouses from database
   */
  async getAllWarehouses(): Promise<any[]> {
    return await strapi.documents('api::warehouse.warehouse').findMany({ filters: {} });
  },

  /**
   * Find closest warehouse to destination using distance calculation
   */
  async findClosestWarehouse(destinationPostalCode: string): Promise<any | null> {
    const warehouses = await this.getAllWarehouses();
    if (warehouses.length === 0) {
      return null;
    }

    if (warehouses.length === 1) {
      return warehouses[0];
    }

    const destAddress = `${destinationPostalCode} CA`;
    let closestWarehouse = warehouses[0];
    let minDistance = Infinity;

    for (const warehouse of warehouses) {
      if (!warehouse.postalCode) continue;

      try {
        const originAddress = `${warehouse.postalCode} CA`;
        const distance = await this.calculateDistance(originAddress, destAddress);
        if (distance < minDistance) {
          minDistance = distance;
          closestWarehouse = warehouse;
        }
      } catch {
        continue;
      }
    }

    return closestWarehouse;
  },

  /**
   * Get origin postal code from warehouse database
   * Priority: warehouse_id > sales_channel_id > closest warehouse > default
   */
  async getOriginPostalCode(
    salesChannelId: string | null | undefined,
    destinationPostalCode?: string,
    warehouseId?: number | string
  ): Promise<string> {
    if (warehouseId) {
      const warehouse = await strapi.documents('api::warehouse.warehouse').findOne({
        documentId: typeof warehouseId === 'string' ? parseInt(warehouseId) : warehouseId,
      });
      if (warehouse?.postalCode) {
        return warehouse.postalCode;
      }
    }

    if (salesChannelId) {
      const warehouses = await strapi.documents('api::warehouse.warehouse').findMany({
        filters: { salesChannelId },
      });
      if (warehouses.length > 0 && warehouses[0].postalCode) {
        return warehouses[0].postalCode;
      }
    }

    if (destinationPostalCode) {
      const closestWarehouse = await this.findClosestWarehouse(destinationPostalCode);
      if (closestWarehouse?.postalCode) {
        return closestWarehouse.postalCode;
      }
    }
    const warehouses = await this.getAllWarehouses();
    if (warehouses.length > 0 && warehouses[0].postalCode) {
      return warehouses[0].postalCode;
    }

    throw new Error('No warehouses found in database. Please add at least one warehouse.');
  },

  /**
   * Convert cart items to boxes array
   */
  convertItemsToBoxes(items: any[]): Box[] {
    const boxes: Box[] = [];

    for (const item of items) {
      const quantity = item.quantity || 1;
      const product = item.product || item.variant || item;
      const { length, width, height, weight } = product;

      if (!length || !width || !height || !weight) {
        throw new Error('Item missing dimensions or weight. Each item must have length, width, height, and weight.');
      }

      for (let i = 0; i < quantity; i++) {
        boxes.push({ length, width, height, weight });
      }
    }

    return boxes;
  },

  /**
   * Calculate shipping price for items or boxes
   */
  async calculateShipping(cart: {
    id?: string;
    sales_channel_id?: string;
    warehouse_id?: number | string;
    items?: any[];
    boxes?: Box[];
    shipping_address: {
      postal_code: string;
      country_code?: string;
    };
  }): Promise<any> {
    const { postal_code: destinationPostalCode, country_code } = cart.shipping_address;

    if (!destinationPostalCode) {
      throw new Error('Missing destination postal code');
    }

    const originPostalCode = await this.getOriginPostalCode(
      cart.sales_channel_id,
      destinationPostalCode,
      cart.warehouse_id
    );

    const originAddress = `${originPostalCode} CA`;
    const destinationAddress = `${destinationPostalCode} CA`;

    const distanceKm = await this.calculateDistance(originAddress, destinationAddress);
    const distanceRange = this.mapDistanceToRange(distanceKm);
    const destinationCountry = country_code || 'CA';

    const boxes = cart.boxes && cart.boxes.length > 0 
      ? cart.boxes 
      : this.convertItemsToBoxes(cart.items || []);

    if (boxes.length === 0) {
      throw new Error('Either items or boxes array is required');
    }

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
   */
  async calculateShippingForBoxes(
    boxes: Box[],
    distanceKm: number,
    distanceRange: string,
    originPostalCode: string,
    destinationPostalCode: string,
    destinationCountry: string = 'CA'
  ): Promise<any> {
    const warehouses = await strapi.documents('api::warehouse.warehouse').findMany({
      filters: { postalCode: originPostalCode },
    });
    const warehouse = warehouses.length > 0 ? warehouses[0] : null;

    const boxResults: any[] = [];
    let subtotal = 0;

    for (const box of boxes) {
      const { length, width, height, weight } = box;
      if (!length || !width || !height || !weight) {
        throw new Error('Box missing dimensions or weight. Each box must have length, width, height, and weight.');
      }

      const cubicFeet = this.calculateCubicFeet(length, width, height);
      const density = this.calculateDensity(length, width, height, weight);
      const freightClass = await this.findFreightClassByDensity(density);

      if (!freightClass) {
        throw new Error(`Could not determine freight class for box with density: ${density.toFixed(2)} PCF`);
      }

      let priceResult = await this.findPriceAndRateByClassAndDistance(freightClass, distanceRange, weight);
      let freightClassUsed = freightClass;

      if (!priceResult && freightClass % 1 !== 0) {
        const roundedClass = Math.round(freightClass);
        priceResult = await this.findPriceAndRateByClassAndDistance(roundedClass, distanceRange, weight);
        if (priceResult) {
          freightClassUsed = roundedClass;
        }
      }

      if (!priceResult) {
        const allPricings = await strapi.documents('api::freight-class-pricing.freight-class-pricing').findMany({
          filters: {},
        });
        const availableClasses: number[] = [...new Set(allPricings.map((p: any) => Number(p.freightClass)))]
          .filter((c: unknown): c is number => typeof c === 'number' && !isNaN(c))
          .sort((a, b) => a - b);

        if (availableClasses.length === 0) {
          throw new Error('No freight class pricing data found in database. Please run the seed script first.');
        }

        const nearestClass = availableClasses.reduce((nearest: number, current: number) => {
          return Math.abs(current - freightClass) < Math.abs(nearest - freightClass) ? current : nearest;
        }, availableClasses[0]);

        priceResult = await this.findPriceAndRateByClassAndDistance(nearestClass, distanceRange, weight);
        if (!priceResult) {
          throw new Error(
            `Could not find pricing for box with freight class: ${freightClass} (tried nearest: ${nearestClass}), ` +
            `distance: ${distanceKm.toFixed(2)} km (range: ${distanceRange}), weight: ${weight.toFixed(2)} lbs.`
          );
        }
        freightClassUsed = nearestClass;
      }

      boxResults.push({
        weightLbs: parseFloat(weight.toFixed(2)),
        cubicFeet: parseFloat(cubicFeet.toFixed(14)),
        densityPcf: parseFloat(density.toFixed(14)),
        freightClass: freightClassUsed,
        distanceKm: parseFloat(distanceKm.toFixed(3)),
        rateSource: 'STRAPI_TABLE',
        ratePerCwt: parseFloat(priceResult.ratePerCwt.toFixed(1)),
        currency: 'CAD',
        price: parseFloat(priceResult.price.toFixed(2)),
        dimensionsIn: {
          lengthIn: parseFloat(length.toFixed(2)),
          widthIn: parseFloat(width.toFixed(2)),
          heightIn: parseFloat(height.toFixed(2)),
        },
      });

      subtotal += priceResult.price;
    }

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
      discountPercent,
      total,
      currency: 'CAD',
    };
  },
});
