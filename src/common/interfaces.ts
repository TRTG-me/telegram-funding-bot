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
    fundingRate: number        // Биржа (B для Binance)
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
    symbol?: string;
    position?: string;
    position_value?: string;
    sign?: 1 | -1; // 1 для Long, -1 для Short
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

