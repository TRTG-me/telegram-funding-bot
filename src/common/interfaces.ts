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