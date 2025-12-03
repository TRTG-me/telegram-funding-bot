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

// Импортируем SDK.
const { Hyperliquid } = require('hyperliquid');

// Тип для полного ответа от запроса "metaAndAssetCtxs"
type MetaAndAssetCtxsResponse = [{ universe: IAssetNameInfoHyper[] }, IAssetDataContextHyper[]];

export class HyperliquidService {
    //private readonly API_URL = 'https://api.hyperliquid.xyz/info';
    private readonly API_URL = 'https://api.hyperliquid-testnet.xyz/info';

    // ID второго декса (Spot или другой Perp universe)
    private readonly SECONDARY_DEX_ID = 'xyz';

    private readonly userAddress: string;
    private readonly userAddress_main: string;
    private readonly privateKey: string;

    private sdk: any = null;
    private sdkInitialized = false;

    constructor() {
        this.userAddress = process.env.HL_WALLET_ADDRESS || '';
        this.userAddress_main = process.env.ACCOUNT_HYPERLIQUID_ETH || '';

        this.privateKey = process.env.HL_PRIVATE_KEY || '';

        if (!this.userAddress) {
            throw new Error('Hyperliquid Wallet Address (ACCOUNT_HYPERLIQUID_ETH) must be provided in .env file');
        }

        if (this.privateKey) {
            this.sdk = new Hyperliquid({
                enableWs: false,
                privateKey: this.privateKey,
                testnet: true,
                walletAddress: this.userAddress,
            });
            this.initSdk().catch(err => console.error('Failed to init Hyperliquid SDK:', err));
        } else {
            console.warn('[Hyperliquid] Private Key missing. Trading functions will not work.');
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

    private async ensureSdkReady() {
        if (!this.sdk) throw new Error('Hyperliquid Private Key is not set.');
        if (!this.sdkInitialized) await this.initSdk();
    }

    private getErrorMessage(error: unknown): string {
        if (error instanceof Error) return error.message;
        try { return JSON.stringify(error); } catch { return String(error); }
    }

    // --- State fetching helper ---
    private async getAccountState(dex?: string): Promise<IHyperliquidAccountInfo> {
        try {
            const body: any = {
                type: 'clearinghouseState',
                user: this.userAddress_main,
            };
            if (dex) {
                body.dex = dex;
            }

            const response = await axios.post(this.API_URL, body);
            return response.data || {};
        } catch (error) {
            if (dex) {
                console.warn(`Failed to fetch Secondary State (dex: ${dex}):`, this.getErrorMessage(error));
                return {} as IHyperliquidAccountInfo;
            }
            const message = this.getErrorMessage(error);
            throw new Error(`Failed to fetch Hyperliquid account state: ${message}`);
        }
    }

    // --- Asset Contexts fetching helper (Single Request) ---
    private async fetchContextsForDex(dex?: string): Promise<ICombinedAssetCtxHyper[]> {
        try {
            const body: any = {
                type: 'metaAndAssetCtxs',
            };
            if (dex) {
                body.dex = dex;
            }

            const response = await axios.post<MetaAndAssetCtxsResponse>(this.API_URL, body);
            const [meta, contexts] = response.data;

            if (!meta?.universe || !contexts) return [];
            if (meta.universe.length !== contexts.length) {
                console.warn(`[Hyperliquid] Universe/Contexts mismatch for dex: ${dex || 'main'}`);
                return [];
            }

            return meta.universe.map((asset, i) => ({
                name: asset.name,
                funding: contexts[i].funding,
            }));

        } catch (error) {
            if (dex) {
                console.warn(`Failed to fetch contexts for dex '${dex}':`, this.getErrorMessage(error));
                return [];
            }
            throw new Error(`Failed to fetch Hyperliquid asset contexts: ${this.getErrorMessage(error)}`);
        }
    }

    // --- Main Asset Contexts (Parallel) ---
    private async getAssetContexts(): Promise<ICombinedAssetCtxHyper[] | null> {
        try {
            const [mainContexts, secondaryContexts] = await Promise.all([
                this.fetchContextsForDex(),                     // Main
                this.fetchContextsForDex(this.SECONDARY_DEX_ID) // Secondary
            ]);

            return [...mainContexts, ...secondaryContexts];
        } catch (error) {
            throw error;
        }
    }

    // --- Core Data Fetcher (Parallel: Main State + Sec State + Contexts) ---
    private async _getCoreAccountData(): Promise<{
        mainState: IHyperliquidAccountInfo,
        secondaryState: IHyperliquidAccountInfo,
        assetContexts: ICombinedAssetCtxHyper[]
    }> {
        const [mainState, secondaryState, assetContexts] = await Promise.all([
            this.getAccountState(),                     // Main
            this.getAccountState(this.SECONDARY_DEX_ID), // Secondary
            this.getAssetContexts()                     // Contexts (Merged)
        ]);

        if (!assetContexts) {
            throw new Error('Incomplete or invalid data received from Hyperliquid API.');
        }

        return { mainState, secondaryState, assetContexts };
    }

    public async getDetailedPositions(): Promise<IDetailedPosition[]> {
        try {
            const { mainState, secondaryState, assetContexts } = await this._getCoreAccountData();

            // Создаем Map для быстрого поиска фандинга по имени монеты
            // (если монеты в двух дексах называются одинаково, победит последняя)
            const fundingMap = new Map<string, string>(
                assetContexts.map(asset => [asset.name, asset.funding])
            );

            const mapPositions = (positions: any[], exchangeLabel: string): IDetailedPosition[] => {
                if (!Array.isArray(positions)) return [];
                return positions
                    .filter(p => p.position?.szi && parseFloat(p.position.szi) !== 0)
                    .map(p => {
                        const position = p.position;
                        const coin = position.coin!;
                        const szi = parseFloat(position.szi!);
                        const notional = position.positionValue!;
                        const hourlyFundingRate = parseFloat(fundingMap.get(coin) || '0');
                        const fundingRate = hourlyFundingRate * 8 * 100;
                        const entryPx = parseFloat(position.entryPx || '0');

                        return {
                            coin: coin,
                            notional: notional,
                            size: Math.abs(szi),
                            side: szi > 0 ? 'L' : 'S',
                            exchange: exchangeLabel,
                            fundingRate: fundingRate,
                            entryPrice: entryPx,
                        };
                    });
            };

            const listA = mapPositions(mainState.assetPositions || [], 'H');
            const listB = mapPositions(secondaryState.assetPositions || [], 'H'); // H_SUB или просто H

            return [...listA, ...listB];

        } catch (err) {
            const message = this.getErrorMessage(err);
            console.error('Error fetching Hyperliquid detailed positions:', err);
            throw new Error(`Failed to get detailed positions from Hyperliquid: ${message}`);
        }
    }
    public async getOpenPosition(symbol: string): Promise<IDetailedPosition | undefined> {
        // Hyperliquid в стейте возвращает "ETH", а мы можем искать "ETH-PERP"
        const cleanSymbol = symbol.replace('-PERP', '');

        const allPositions = await this.getDetailedPositions();
        return allPositions.find(p => p.coin === cleanSymbol);
    }

    public async calculateLeverage(): Promise<IExchangeData> {
        try {
            const { mainState, secondaryState } = await this._getCoreAccountData();

            const extractData = (state: IHyperliquidAccountInfo) => {
                if (!state.marginSummary) return { val: 0, ntl: 0, maint: 0 };
                return {
                    val: parseFloat(state.marginSummary.accountValue || '0'),
                    ntl: parseFloat(state.marginSummary.totalNtlPos || '0'),
                    maint: parseFloat(state.crossMaintenanceMarginUsed || '0')
                };
            };

            const main = extractData(mainState);
            const sec = extractData(secondaryState);

            const totalAccountValue = main.val + sec.val;
            const totalNotional = main.ntl + sec.ntl;
            const totalMaintUsed = main.maint + sec.maint;

            const denominator = totalAccountValue - totalMaintUsed;
            let leverage = 0;

            if (denominator !== 0) {
                leverage = totalNotional / denominator;
            }

            if (totalAccountValue === 0 && totalNotional === 0 && main.val !== 0) {
                return { leverage: main.ntl / (main.val - main.maint), accountEquity: main.val };
            }

            return {
                leverage,
                accountEquity: totalAccountValue,
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
            const result = await this.sdk.custom.marketOpen(symbol, isBuy, quantity);

            const statuses = result.response?.data?.statuses;
            if (!statuses || statuses.length === 0) {
                throw new Error(`Unknown response structure: ${JSON.stringify(result)}`);
            }

            const statusInfo = statuses[0];
            if (statusInfo.error) {
                throw new Error(`Hyperliquid returned error: ${statusInfo.error}`);
            }

            const filledData = statusInfo.filled;
            const restingData = statusInfo.resting;

            const oid = filledData?.oid || restingData?.oid;
            const avgPrice = filledData?.avgPx || restingData?.limitPx || '0';
            const executedQty = filledData?.totalSz || restingData?.sz || quantity;

            const responseData = {
                symbol: symbol,
                orderId: oid,
                side: side,
                status: filledData ? 'FILLED' : 'NEW',
                avgPrice: parseFloat(avgPrice),
                executedQty: parseFloat(executedQty),
                originalResponse: statusInfo
            };

            return responseData;

        } catch (err) {
            console.error('Error placing Hyperliquid order:', err);
            const message = this.getErrorMessage(err);
            throw new Error(`Failed to place order on Hyperliquid: ${message}`);
        }
    }
}