// src/modules/binance/binance.service.ts
import axios from 'axios';
import {
    DerivativesTradingPortfolioMargin,
    DERIVATIVES_TRADING_PORTFOLIO_MARGIN_REST_API_PROD_URL,
} from '@binance/derivatives-trading-portfolio-margin';

import { IExchangeData, IDetailedPosition, IAccountInfoBin, IPositionInfoBin } from '../../common/interfaces';

export class BinanceService {
    private client: DerivativesTradingPortfolioMargin;

    // Смещение локального времени относительно серверного Binance
    private timeOffset = 0;

    // Для мини‑логов задержки сети
    private lastRttMs = 0;

    constructor() {
        const apiKey = process.env.BINANCE_API_KEY;
        const apiSecret = process.env.BINANCE_API_SECRET;
        if (!apiKey || !apiSecret) {
            throw new Error('Binance API Key and Secret must be provided in .env file');
        }

        const configurationRestAPI = {
            apiKey,
            apiSecret,
            basePath: DERIVATIVES_TRADING_PORTFOLIO_MARGIN_REST_API_PROD_URL,
            recvWindow: 20000, // базовое; на подписанных вызовах проставим своё 60000
        };

        this.client = new DerivativesTradingPortfolioMargin({ configurationRestAPI });

        // Первичная синхронизация времени и периодическое обновление
        this.syncTime().catch(() => { });
        setInterval(() => this.syncTime().catch(() => { }), 60_000);
    }

    // ===== СИНХРОНИЗАЦИЯ ВРЕМЕНИ =====
    private async syncTime() {
        const start = Date.now();
        const r = await axios.get('https://fapi.binance.com/fapi/v1/time');
        const end = Date.now();
        const serverTime = r.data.serverTime as number;
        this.lastRttMs = end - start;
        this.timeOffset = serverTime - end;
        //console.log('[Binance time sync] serverTime:', serverTime, 'localNow:', end, 'delta(ms):', this.timeOffset, 'RTT(ms):', this.lastRttMs);
    }

    private nowMs() {
        return Date.now() + this.timeOffset;
    }

    // ===== ХЕЛПЕР ОШИБОК =====
    private getErrorMessage(error: unknown): string {
        if (error instanceof Error) return error.message;
        try { return JSON.stringify(error); } catch { return String(error); }
    }

    // ===== ПУБЛИЧНЫЕ МЕТОДЫ (СТАРАЯ ЛОГИКА SDK) =====

    // 1) Информация об аккаунте (PM/Futures через SDK)
    public async getAccountInfo(): Promise<IAccountInfoBin> {
        try {
            const resp = await (this.client as any).restAPI.accountInformation({
                timestamp: this.nowMs(),
                recvWindow: 60000,
            });
            const data = typeof resp?.data === 'function' ? await resp.data() : (resp?.data ?? resp);
            return data as IAccountInfoBin;
        } catch (err) {
            console.error('Error fetching Binance account info:', err);
            const message = this.getErrorMessage(err);
            throw new Error(`Failed to fetch account info from Binance API: ${message}`);
        }
    }

    // 2) Позиции (через SDK, как раньше)
    public async getPositionInfo(): Promise<IPositionInfoBin[]> {
        try {
            const ts = this.nowMs();
            // console.log('[Binance SDK GET] queryUmPositionInformation timestamp:', ts, 'recvWindow:', 60000);
            const resp = await (this.client as any).restAPI.queryUmPositionInformation({
                timestamp: ts,
                recvWindow: 60000,
            });
            const data = typeof resp?.data === 'function' ? await resp.data() : (resp?.data ?? resp);
            return (Array.isArray(data) ? data : []) as IPositionInfoBin[];
        } catch (err) {
            console.error('Error fetching Binance position info:', err);
            const message = this.getErrorMessage(err);
            throw new Error(`Failed to fetch position info from Binance API: ${message}`);
        }
    }

    // 3) Детальные позиции (оставлена прежняя логика)
    public async getDetailedPositions(): Promise<IDetailedPosition[]> {
        try {
            // --- Шаг 1: Получаем позиции и интервалы фандинга ---
            const [positions, fundingInfoResponse] = await Promise.all([
                this.getPositionInfo(),
                axios.get('https://fapi.binance.com/fapi/v1/fundingInfo'),
            ]);

            const fundingIntervals = new Map<string, number>();
            for (const info of fundingInfoResponse.data) {
                fundingIntervals.set(info.symbol, info.fundingIntervalHours);
            }

            // --- Шаг 2: Только открытые позиции ---
            const openPositions = positions.filter(p => p.positionAmt && parseFloat(p.positionAmt) !== 0);

            // --- Шаг 3: Для каждой позиции берём premiumIndex и считаем ---
            const positionDetailsPromises = openPositions.map(async (position): Promise<IDetailedPosition> => {
                const symbol = position.symbol!;
                const premiumIndexResponse = await axios.get(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`);
                const premiumIndexData = premiumIndexResponse.data;

                const notional = Math.abs(parseFloat(position.notional!));
                const numericPositionAmt = parseFloat(position.positionAmt!);

                let fundingRate = parseFloat(premiumIndexData.lastFundingRate) * 100; // %
                const interval = fundingIntervals.get(symbol);
                if (interval === 4) {
                    fundingRate *= 2; // приведение к 8-часовому окну
                }

                return {
                    coin: symbol.replace(/USDT|USDC$/, ''),
                    notional: notional.toString(),
                    size: Math.abs(numericPositionAmt),
                    side: numericPositionAmt > 0 ? 'L' : 'S',
                    exchange: 'B',
                    fundingRate,
                };
            });

            const detailed = await Promise.all(positionDetailsPromises);
            // console.log('[Binance positions] count:', detailed.length);
            return detailed;
        } catch (err) {
            console.error('Error fetching or processing Binance detailed positions:', err);
            const message = this.getErrorMessage(err);
            throw new Error(`Failed to get detailed positions from Binance: ${message}`);
        }
    }

    // 4) Расчёт плеча (как у тебя)
    public async calculateLeverage(): Promise<{ leverage: number; accountEquity: number }> {
        try {
            const [accountInfo, positionInfo] = await Promise.all([
                this.getAccountInfo(),
                this.getPositionInfo(),
            ]);

            if (!accountInfo || typeof accountInfo.accountEquity !== 'string' || typeof accountInfo.accountMaintMargin !== 'string') {
                throw new Error('Incomplete account data: accountEquity or accountMaintMargin is missing from API response.');
            }

            const totalNotional = positionInfo.reduce((sum, position) => {
                return sum + Math.abs(parseFloat(position.notional || '0'));
            }, 0);

            const accountEquity = parseFloat(accountInfo.accountEquity);
            const accountMaintMargin = parseFloat(accountInfo.accountMaintMargin);
            if (isNaN(accountEquity) || isNaN(accountMaintMargin)) {
                throw new Error('Failed to parse financial data from API response.');
            }

            const denominator = accountEquity - accountMaintMargin;
            if (denominator === 0) {
                if (totalNotional !== 0) {
                    throw new Error('Cannot calculate leverage: Division by zero (accountEquity equals accountMaintMargin).');
                }
                return { leverage: 0, accountEquity };
            }

            const leverage = totalNotional / denominator;
            if (!isFinite(leverage)) {
                throw new Error('Calculated leverage resulted in an infinite number.');
            }

            return { leverage, accountEquity };
        } catch (err) {
            console.error('Error during leverage calculation:', err);
            const message = this.getErrorMessage(err);
            throw new Error(`Failed to calculate account leverage: ${message}`);
        }
    }

    // 5) Публичные данные (как было)
    public async getExchangeData(symbol: string): Promise<IExchangeData> {
        const url = `https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${encodeURIComponent(symbol)}`;
        const start = Date.now();
        const res = await axios.get(url);
        const end = Date.now();
        // console.log('[Binance public GET] /ticker/24hr RTT(ms):', end - start);
        return res.data as IExchangeData;
    }
}

export default BinanceService;
