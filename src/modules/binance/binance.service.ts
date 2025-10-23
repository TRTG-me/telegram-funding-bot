// src/modules/binance/binance.service.ts
import {
    DerivativesTradingPortfolioMargin,
    DERIVATIVES_TRADING_PORTFOLIO_MARGIN_REST_API_PROD_URL,
} from '@binance/derivatives-trading-portfolio-margin';
import { IExchangeData } from '../../common/interfaces'
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