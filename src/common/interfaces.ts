export interface IExchangeData {
    leverage: number;
    accountEquity: number;
}

export interface IDetailedPosition {
    coin: string;           // Название монеты (например, ETH)
    notional: string;       // Номинальная стоимость позиции в USDT/USDC
    size: number;           // Размер позиции (абсолютное значение)
    side: 'L' | 'S';        // Сторона позиции: L - Long, S - Short
    exchange: string;
    fundingRate: number
    entryPrice?: number     // Биржа (B для Binance)
}

export interface IParadexAccountResponse {
    account_value?: string;
    maintenance_margin_requirement?: string;
}

export interface IParadexPosition {
    status?: 'OPEN' | 'CLOSED';
    cost_usd?: string;
    cost?: string
    unrealized_pnl?: string;
    unrealized_funding_pnl?: string;
    market?: string;
    size?: string;
    side?: 'LONG' | 'SHORT';
    average_entry_price?: string;
}

export interface IParadexPositionsResponse {
    results: IParadexPosition[];
}

type UnixTime = number;
export interface IAuthRequest extends Record<string, unknown> {
    method: string;
    path: string;
    body: string;
    timestamp: UnixTime;
    expiration: UnixTime;
}
export interface IValidAccountInfoBin {
    accountEquity: string;
    accountStatus: string;

}

export interface IAccountInfoBin {
    accountEquity?: string;
    accountMaintMargin?: string;
    uniMMR?: string;
    actualEquity?: string;
    accountInitialMargin?: string;
    accountStatus?: string;
    virtualMaxWithdrawAmount?: string;
    totalAvailableBalance?: string;
    totalMarginOpenLoss?: string;
    updateTime?: number;
    totalInitialMargin?: string;
    totalMaintMargin?: string;     // MaintMargin в Standard
    totalWalletBalance?: string;
    totalUnrealizedProfit?: string;
    totalMarginBalance?: string;   // Equity в Standard
    totalPositionInitialMargin?: string;
    totalOpenOrderInitialMargin?: string;
    totalCrossWalletBalance?: string;
    totalCrossUnPnl?: string;
    availableBalance?: string;
    maxWithdrawAmount?: string;

    // --- Общие поля (если есть) ---
    assets?: any[];
    positions?: any[];
}

export interface IPositionInfoBin {
    symbol?: string;
    notional?: string;
    positionAmt?: string;
    entryPrice?: string;
    markPrice?: string;
    unRealizedProfit?: string;
    liquidationPrice?: string;
    leverage?: string;
    positionSide?: string;
    updateTime?: number;
    maxNotionalValue?: string;
    breakEvenPrice?: string;
}
export interface IExtendedBalanceData {
    exposure?: string;
    equity?: string;
    initialMargin?: string;
}
export interface IExtendedApiResponse {
    status?: string;
    data?: IExtendedBalanceData;
}
export interface IExtendedPosition {
    market: string;
    status: 'OPENED' | 'CLOSED';
    side: 'LONG' | 'SHORT';
    size: string;
    value: string;
    openPrice: string;
}
export interface IExtendedPositionsResponse {
    status: 'OK' | 'ERROR';
    data: IExtendedPosition[];
}

export interface IExtendedMarketStatsData {
    fundingRate: string;
}

export interface IExtendedMarketStatsResponse {
    status: 'OK' | 'ERROR';
    data: IExtendedMarketStatsData;
}

export interface IAssetNameInfoHyper {
    name: string;
}
export interface IAssetDataContextHyper {
    funding: string;
}
// Тип для "склеенных" данных по одному активу
export interface ICombinedAssetCtxHyper {
    name: string;
    funding: string;
}
export interface IHyperliquidAccountInfo {
    marginSummary?: {
        accountValue?: string;
        totalNtlPos?: string;
    };
    assetPositions?: {
        position: {
            coin?: string;
            szi?: string;
            positionValue?: string;
        }
    }[];
    crossMaintenanceMarginUsed?: string;
}
// Детали одной открытой позиции для отображения
export interface IPositionDetailHyper {
    coin: string;
    side: 'Long' | 'Short';
    size: number;
    notionalValue: number;
    fundingRate: number; // Уже в процентах
}

export interface IFullAccountSummaryHyper {
    leverage: number;
    accountEquity: number;
}

export interface ILighterPosition {
    market_id: number;
    symbol?: string;
    position?: string;       // Размер позиции
    position_value?: string; // Notional value
    sign?: 1 | -1;           // 1 = Long, -1 = Short
    avg_entry_price?: string;
    unrealized_pnl?: string;
    // ... остальные поля не критичны для этого метода
}

export interface ILighterAccount {
    available_balance?: string;
    total_asset_value?: string;
    positions?: ILighterPosition[];
}

export interface ILighterApiResponse {
    accounts?: ILighterAccount[];
}
export interface IFundingRateLighter {
    exchange: string;
    symbol: string;
    rate: number;
}

export interface IFundingRatesResponseLighter {
    funding_rates?: IFundingRateLighter[];
}

export interface IFundingResultRow {
    coin: string;
    notional: number;
    exchanges: string;
    funding_1d: number;
    funding_3d: number;
    funding_7d: number;
    funding_14d: number;
}

export interface IUnhedgedFundingResultRow {
    coin: string;
    notional: number;
    exchange: string;
    side: 'LONG' | 'SHORT';
    funding_1d: number;
    funding_3d: number;
    funding_7d: number;
    funding_14d: number;
}

export interface IHistoricalFundingData {
    hedged: IFundingResultRow[];
    unhedged: IUnhedgedFundingResultRow[];
}

export interface IFundingToolsData {
    contract_1_section?: string;
    contract_1_total_funding?: number;
    contract_2_section?: string;
    contract_2_total_funding?: number;
}
export interface IFundingToolsResponse { data: IFundingToolsData[]; }
export interface IParadexMarket {
    base_currency?: string;
    funding_period_hours?: number;
}
export interface IParadexMarketsResponse { results: IParadexMarket[]; }
