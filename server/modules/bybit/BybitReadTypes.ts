export type BybitLinearPerpetualInstrument = {
  symbol: string;
  contractType: "LinearPerpetual";
  status: string;
  baseCoin: string;
  quoteCoin: string;
  settleCoin: string;
  priceFilter: { tickSize: string };
  lotSizeFilter: {
    minNotionalValue: string;
    minOrderQty: string;
    qtyStep: string;
  };
};

export type BybitFundingTicker = {
  symbol: string;
  fundingRate: string;
  fundingIntervalHour: string;
  nextFundingTime: string;
  markPrice: string;
};

export type BybitInstrumentBinding = Readonly<{
  instrumentId: string;
  providerSymbol: string;
}>;
