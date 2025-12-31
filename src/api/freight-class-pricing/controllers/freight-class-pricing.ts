/**
 * freight-class-pricing controller
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreController('api::freight-class-pricing.freight-class-pricing' as any, ({ strapi }) => ({
  async find(ctx) {
    const { data, meta } = await super.find(ctx);
    
    // Get discount settings
    const settings = await strapi.service('api::discount-settings.discount-setting').find();
    const applyDiscount = settings?.isDiscountEnabled && settings?.discountPercentage;
    
    if (applyDiscount && data) {
      const discountPercentage = settings.discountPercentage;
      const discountMultiplier = 1 - (discountPercentage / 100);
      
      // Apply discount to prices
      const discountedData = Array.isArray(data) 
        ? data.map((item: any) => ({
            ...item,
            originalPrice: item.price,
            price: Math.max(0, parseFloat(item.price) * discountMultiplier),
            discountApplied: discountPercentage,
          }))
        : {
            ...data,
            originalPrice: data.price,
            price: Math.max(0, parseFloat(data.price) * discountMultiplier),
            discountApplied: discountPercentage,
          };
      
      return { data: discountedData, meta };
    }
    
    return { data, meta };
  },

  async findOne(ctx) {
    const { data, meta } = await super.findOne(ctx);
    
    // Get discount settings
    const settings = await strapi.service('api::discount-settings.discount-setting').find();
    const applyDiscount = settings?.isDiscountEnabled && settings?.discountPercentage;
    
    if (applyDiscount && data) {
      const discountPercentage = settings.discountPercentage;
      const discountMultiplier = 1 - (discountPercentage / 100);
      
      return {
        data: {
          ...data,
          originalPrice: data.price,
          price: Math.max(0, parseFloat(data.price) * discountMultiplier),
          discountApplied: discountPercentage,
        },
        meta,
      };
    }
    
    return { data, meta };
  },
}));

