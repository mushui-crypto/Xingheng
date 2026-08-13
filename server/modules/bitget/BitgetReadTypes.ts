export type BitgetUsdtPerpetualInstrument = {
  symbol: string;
  baseCoin: string;
  quoteCoin: string;
  minTradeNum: string;
  minTradeUSDT: string;
  priceEndStep: string;
  pricePlace: string;
  sizeMultiplier: string;
  symbolType: string;
  symbolStatus: string;
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
