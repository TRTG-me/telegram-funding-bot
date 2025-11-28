// src/modules/hyperliquid/hyperliquid.service.ts

import axios from 'axios';
import {
    IExchangeData,
    IDetailedPosition,
    IHyperliquidAccountInfo,
    ICombinedAssetCtxHyper,
    IAssetNameInfoHyper,
    IAssetDataContextHyper
} from '../../common/interfaces';

// Импортируем SDK. Используем require, так как у этой библиотеки нет официальных типов @types
const { Hyperliquid } = require('hyperliquid');

// Тип для полного ответа от запроса "metaAndAssetCtxs"
type MetaAndAssetCtxsResponse = [{ universe: IAssetNameInfoHyper[] }, IAssetDataContextHyper[]];

export class HyperliquidService {
    private readonly API_URL = 'https://api.hyperliquid.xyz/info';

    // Данные для подключения
    private readonly userAddress: string;
    private readonly userAddress_main: string;
    private readonly privateKey: string;

    // Экземпляр SDK
    private sdk: any = null;
    private sdkInitialized = false;

    constructor() {
        this.userAddress = process.env.HL_WALLET_ADDRESS || '';
        this.userAddress_main = process.env.ACCOUNT_HYPERLIQUID_ETH || '';
        this.privateKey = process.env.HL_PRIVATE_KEY || '';

        if (!this.userAddress) {
            throw new Error('Hyperliquid Wallet Address (ACCOUNT_HYPERLIQUID_ETH) must be provided in .env file');
        }

        // Если есть приватный ключ, инициализируем SDK для торговли
        if (this.privateKey) {
            this.sdk = new Hyperliquid({
                enableWs: false, // Нам пока хватит REST
                privateKey: this.privateKey,
                testnet: true,  // false = Mainnet
                walletAddress: this.userAddress,
            });

            // Инициализацию запускаем в фоне, чтобы не блокировать конструктор
            this.initSdk().catch(err => console.error('Failed to init Hyperliquid SDK:', err));
        } else {
            console.warn('[Hyperliquid] Private Key missing. Trading functions will not work, only data fetching.');
        }
    }

    private async initSdk() {
        if (!this.sdk || this.sdkInitialized) return;
        try {
            await this.sdk.initialize();
            this.sdkInitialized = true;
            console.log('[Hyperliquid] SDK Initialized successfully');
        } catch (e) {
            console.error('[Hyperliquid] SDK Initialization error:', e);
        }
    }

    // Хелпер: ждем инициализации перед торговым запросом
    private async ensureSdkReady() {
        if (!this.sdk) throw new Error('Hyperliquid Private Key is not set.');
        if (!this.sdkInitialized) await this.initSdk();
    }

    private getErrorMessage(error: unknown): string {
        if (error instanceof Error) return error.message;
        try { return JSON.stringify(error); } catch { return String(error); }
    }

    private async getAccountState(): Promise<IHyperliquidAccountInfo> {
        try {
            const response = await axios.post(this.API_URL, {
                type: 'clearinghouseState',
                user: this.userAddress_main,
            });
            return response.data || {};
        } catch (error) {
            const message = this.getErrorMessage(error);
            throw new Error(`Failed to fetch Hyperliquid account state: ${message}`);
        }
    }

    private async getAssetContexts(): Promise<ICombinedAssetCtxHyper[] | null> {
        try {
            const response = await axios.post<MetaAndAssetCtxsResponse>(this.API_URL, {
                type: 'metaAndAssetCtxs',
            });
            const [meta, contexts] = response.data;
            if (meta.universe.length !== contexts.length) {
                console.error("Universe and contexts arrays have different lengths!");
                return null;
            }
            return meta.universe.map((asset, i) => ({
                name: asset.name,
                funding: contexts[i].funding,
            }));
        } catch (error) {
            const message = this.getErrorMessage(error);
            throw new Error(`Failed to fetch Hyperliquid asset contexts: ${message}`);
        }
    }

    private async _getCoreAccountData(): Promise<{ accountState: IHyperliquidAccountInfo, assetContexts: ICombinedAssetCtxHyper[] }> {
        const [accountState, assetContexts] = await Promise.all([
            this.getAccountState(),
            this.getAssetContexts()
        ]);

        if (!Array.isArray(accountState.assetPositions) || !assetContexts) {
            throw new Error('Incomplete or invalid data received from Hyperliquid API.');
        }

        return { accountState, assetContexts };
    }

    public async getDetailedPositions(): Promise<IDetailedPosition[]> {
        try {
            const { accountState, assetContexts } = await this._getCoreAccountData();

            const fundingMap = new Map<string, string>(
                assetContexts.map(asset => [asset.name, asset.funding])
            );

            return accountState.assetPositions
                ?.filter(p => p.position?.szi && parseFloat(p.position.szi) !== 0)
                .map(p => {
                    const position = p.position;
                    const coin = position.coin!;
                    const szi = parseFloat(position.szi!);
                    const notional = position.positionValue!;
                    const hourlyFundingRate = parseFloat(fundingMap.get(coin) || '0');
                    const fundingRate = hourlyFundingRate * 8 * 100;

                    return {
                        coin: coin,
                        notional: notional,
                        size: Math.abs(szi),
                        side: szi > 0 ? 'L' : 'S',
                        exchange: 'H',
                        fundingRate: fundingRate,
                    };
                }) || [];

        } catch (err) {
            const message = this.getErrorMessage(err);
            console.error('Error fetching Hyperliquid detailed positions:', err);
            throw new Error(`Failed to get detailed positions from Hyperliquid: ${message}`);
        }
    }

    public async calculateLeverage(): Promise<IExchangeData> {
        try {
            const { accountState } = await this._getCoreAccountData();

            if (
                !accountState.marginSummary ||
                typeof accountState.marginSummary.accountValue !== 'string' ||
                typeof accountState.marginSummary.totalNtlPos !== 'string' ||
                typeof accountState.crossMaintenanceMarginUsed !== 'string'
            ) {
                throw new Error('Incomplete margin data received from Hyperliquid API.');
            }

            const accountValue = parseFloat(accountState.marginSummary.accountValue);
            const marginUsed = parseFloat(accountState.crossMaintenanceMarginUsed);
            const totalNtlPos = parseFloat(accountState.marginSummary.totalNtlPos);

            if (isNaN(accountValue) || isNaN(marginUsed) || isNaN(totalNtlPos)) {
                throw new Error('Failed to parse financial data from API response.');
            }

            const denominator = accountValue - marginUsed;
            let leverage = 0;

            if (denominator !== 0) {
                leverage = totalNtlPos / denominator;
                if (!isFinite(leverage)) {
                    throw new Error('Leverage calculation resulted in a non-finite number.');
                }
            }

            return {
                leverage,
                accountEquity: accountValue,
            };

        } catch (err) {
            const message = this.getErrorMessage(err);
            console.error('Error during Hyperliquid leverage calculation:', err);
            throw new Error(`Failed to calculate Hyperliquid leverage: ${message}`);
        }
    }

    public async placeMarketOrder(
        symbol: string,
        side: 'BUY' | 'SELL',
        quantity: number
    ): Promise<any> {
        try {
            await this.ensureSdkReady();
            console.log(`[Hyperliquid] Placing MARKET order: ${side} ${quantity} ${symbol}`);

            const isBuy = side === 'BUY';

            // 1. Отправляем ордер
            const result = await this.sdk.custom.marketOpen(
                symbol,
                isBuy,
                quantity
            );

            // 2. Валидация ответа
            const statuses = result.response?.data?.statuses;
            if (!statuses || statuses.length === 0) {
                throw new Error(`Unknown response structure: ${JSON.stringify(result)}`);
            }

            const statusInfo = statuses[0];
            if (statusInfo.error) {
                throw new Error(`Hyperliquid returned error: ${statusInfo.error}`);
            }

            // 3. ПАРСИНГ ДАННЫХ (Самое важное)
            // Для Маркет ордера данные лежат в поле 'filled'
            // Для Лимитного (который не исполнился сразу) в поле 'resting'
            const filledData = statusInfo.filled;
            const restingData = statusInfo.resting;

            // Достаем ID
            const oid = filledData?.oid || restingData?.oid;

            // Достаем Цену исполнения (avgPx)
            // Если filled - там есть avgPx. Если resting - берем limitPx (хотя для маркета resting редкость)
            const avgPrice = filledData?.avgPx || restingData?.limitPx || '0';

            // Достаем Исполненный объем
            const executedQty = filledData?.totalSz || restingData?.sz || quantity;

            // 4. Формируем красивый объект для контроллера
            const responseData = {
                symbol: symbol,
                orderId: oid,
                side: side,
                status: filledData ? 'FILLED' : 'NEW',

                // ВАЖНО: возвращаем то, что достали из filled
                avgPrice: parseFloat(avgPrice),
                executedQty: parseFloat(executedQty),

                originalResponse: statusInfo
            };

            console.log('[Hyperliquid] Market Order parsed:', responseData);
            return responseData;

        } catch (err) {
            console.error('Error placing Hyperliquid order:', err);
            const message = this.getErrorMessage(err);
            throw new Error(`Failed to place order on Hyperliquid: ${message}`);
        }
    }

}