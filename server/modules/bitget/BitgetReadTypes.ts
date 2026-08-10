export type BitgetUsdtPerpetualInstrument = {
  symbol: string;
  category: "USDT-FUTURES";
  baseCoin: string;
  quoteCoin: string;
  minOrderQty: string;
  minOrderAmount: string;
  priceMultiplier: string;
  quantityMultiplier: string;
  type: "perpetual";
  status: string;
};

export type BitgetFundingRateRecord = {
  symbol: string;
  fundingRate: string;
  fundingRateInterval: string;
  nextUpdate: string;
};

export type BitgetMarketTicker = {
  symbol: string;
  bidPr: string;
  askPr: string;
};

export type BitgetInstrumentBinding = Readonly<{
  instrumentId: string;
  providerSymbol: string;
}>;
