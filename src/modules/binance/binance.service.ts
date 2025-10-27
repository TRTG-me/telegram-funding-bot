import axios from 'axios';

import {
    DerivativesTradingPortfolioMargin,
    DERIVATIVES_TRADING_PORTFOLIO_MARGIN_REST_API_PROD_URL,
} from '@binance/derivatives-trading-portfolio-margin';
import { IExchangeData, IDetailedPosition } from '../../common/interfaces'


/**
 * Интерфейс для данных аккаунта, основанный на ответе API.
 * Свойства необязательны (?), так как API может их не вернуть.
 */
interface AccountInfo {
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

/**
 * Интерфейс для данных одной позиции, основанный на ответе API.
 * Свойства необязательны (?).
 */
interface PositionInfo {
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

/**
 * НОВЫЙ ИНТЕРФЕЙС
 * Интерфейс для детализированных данных по одной позиции в унифицированном формате.
 */

export class BinanceService {
    private client: DerivativesTradingPortfolioMargin;

    constructor() {
        const apiKey = process.env.BINANCE_API_KEY;
        const apiSecret = process.env.BINANCE_API_SECRET;

        if (!apiKey || !apiSecret) {
            throw new Error('Binance API Key and Secret must be provided in .env file');
        }

        const configurationRestAPI = {
            apiKey: apiKey,
            apiSecret: apiSecret,
            basePath: DERIVATIVES_TRADING_PORTFOLIO_MARGIN_REST_API_PROD_URL,
            recvWindow: 10000,
        };

        this.client = new DerivativesTradingPortfolioMargin({ configurationRestAPI });
    }

    /**
     * Вспомогательная функция для извлечения сообщения об ошибке.
     * @param error Ошибка неизвестного типа.
     * @returns Строка с сообщением об ошибке.
     */
    private getErrorMessage(error: unknown): string {
        if (error instanceof Error) {
            // Если это стандартный объект Error, возвращаем его сообщение
            return error.message;
        }
        // Если выброшено что-то другое (строка, число), преобразуем в строку
        return String(error);
    }


    public async getAccountInfo(): Promise<AccountInfo> {
        try {
            const response = await this.client.restAPI.accountInformation();
            return await response.data();
        } catch (err) {
            console.error('Error fetching Binance account info:', err);
            const message = this.getErrorMessage(err);
            throw new Error(`Failed to fetch account info from Binance API: ${message}`);
        }
    }


    public async getPositionInfo(): Promise<PositionInfo[]> {
        try {
            const response = await this.client.restAPI.queryUmPositionInformation();
            return (await response.data()) || [];
        } catch (err) {
            console.error('Error fetching Binance position info:', err);
            const message = this.getErrorMessage(err);
            throw new Error(`Failed to fetch position info from Binance API: ${message}`);
        }
    }


    public async getDetailedPositions(): Promise<IDetailedPosition[]> {
        try {
            // --- Шаг 1: Получаем основные данные по позициям и интервалы фандинга ---
            const [positions, fundingInfoResponse] = await Promise.all([
                this.getPositionInfo(),
                axios.get('https://fapi.binance.com/fapi/v1/fundingInfo')
            ]);

            // Создаем карту для быстрого доступа к интервалам фандинга по символу
            const fundingIntervals = new Map<string, number>();
            for (const info of fundingInfoResponse.data) {
                fundingIntervals.set(info.symbol, info.fundingIntervalHours);
            }

            // --- Шаг 2: Фильтруем только открытые позиции ---
            const openPositions = positions.filter(p => p.positionAmt && parseFloat(p.positionAmt) !== 0);

            // --- Шаг 3: Для каждой открытой позиции запрашиваем ставку фандинга ---
            const positionDetailsPromises = openPositions.map(async (position): Promise<IDetailedPosition> => {
                const symbol = position.symbol!;

                // Запрашиваем premiumIndex для конкретной монеты
                const premiumIndexResponse = await axios.get(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`);
                const premiumIndexData = premiumIndexResponse.data;

                // --- Шаг 4: Выполняем расчеты ---
                const notional = position.notional!;
                const positionAmt = position.positionAmt!;
                const numericPositionAmt = parseFloat(positionAmt);

                // Базовая ставка фандинга в %
                let fundingRate = parseFloat(premiumIndexData.lastFundingRate) * 100;

                // Приводим к 8-часовому интервалу
                const interval = fundingIntervals.get(symbol);
                if (interval === 4) {
                    fundingRate *= 2;
                }

                return {
                    coin: symbol.replace(/USDT|USDC$/, ''),
                    notional: notional,
                    size: Math.abs(numericPositionAmt),
                    side: numericPositionAmt > 0 ? 'L' : 'S',
                    exchange: 'B',
                    fundingRate: fundingRate, // Добавляем рассчитанный фандинг
                };
            });

            // --- Шаг 5: Ожидаем выполнения всех запросов и возвращаем результат ---
            return Promise.all(positionDetailsPromises);

        } catch (err) {
            console.error('Error fetching or processing Binance detailed positions:', err);
            const message = this.getErrorMessage(err);
            throw new Error(`Failed to get detailed positions from Binance: ${message}`);
        }
    }

    public async calculateAccountLeverage(): Promise<IExchangeData> {
        try {
            const [accountInfo, positionInfo] = await Promise.all([
                this.getAccountInfo(),
                this.getPositionInfo(),
            ]);

            if (!accountInfo || typeof accountInfo.accountEquity !== 'string' || typeof accountInfo.accountMaintMargin !== 'string') {
                throw new Error('Incomplete account data: accountEquity or accountMaintMargin is missing from API response.');
            }

            const totalNotional = positionInfo.reduce((sum, position) => {
                return sum + parseFloat(position.notional || '0');
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
                return { leverage: 0, accountEquity: accountEquity };
            }

            const leverage = totalNotional / denominator;

            if (!isFinite(leverage)) {
                throw new Error('Calculated leverage resulted in an infinite number.');
            }

            return { leverage, accountEquity };

        } catch (err) {
            // Теперь обработка ошибки полностью типобезопасна
            console.error('Error during leverage calculation:', err);
            const message = this.getErrorMessage(err);
            throw new Error(`Failed to calculate account leverage: ${message}`);
        }
    }
}