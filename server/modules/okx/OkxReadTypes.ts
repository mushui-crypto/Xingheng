export type OkxSwapInstrument = {
  instType: "SWAP";
  instId: string;
  uly: string;
  settleCcy: string;
  ctType: "linear";
  ctVal: string;
  ctValCcy: string;
  tickSz: string;
  lotSz: string;
  minSz: string;
  state: string;
};

export type OkxFundingRateRecord = {
  instType: "SWAP";
  instId: string;
  fundingRate: string;
  fundingTime: string;
  nextFundingTime: string;
};

export type OkxInstrumentBinding = Readonly<{
  instrumentId: string;
  providerSymbol: string;
}>;
