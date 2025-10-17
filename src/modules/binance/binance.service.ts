// src/modules/binance/binance.service.ts
import {
    DerivativesTradingPortfolioMargin,
    DERIVATIVES_TRADING_PORTFOLIO_MARGIN_REST_API_PROD_URL,
} from '@binance/derivatives-trading-portfolio-margin';

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
        };

        this.client = new DerivativesTradingPortfolioMargin({ configurationRestAPI });
    }

    /**
     * Получает информацию об аккаунте из Binance API.
     * @returns Объект с данными аккаунта.
     */
    public async getAccountInfo() {
        try {
            const response = await this.client.restAPI.accountInformation();
            return await response.data();
        } catch (err) {
            console.error('Error fetching Binance account info:', err);
            throw new Error('Failed to fetch account info from Binance API.');
        }
    }
    public async getPositionInfo() {

        try {

            const response = await this.client.restAPI.queryUmPositionInformation();

            return await response.data();
        } catch (err) {
            console.error('Error fetching Binance position info:', err);
            // Генерируем ошибку, чтобы контроллер мог ее поймать
            throw new Error('Failed to fetch position info from Binance API.');
        }
    }

}