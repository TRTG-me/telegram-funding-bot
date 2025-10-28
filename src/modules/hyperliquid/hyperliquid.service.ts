// src/modules/hyperliquid/hyperliquid.service.ts

import axios from 'axios';
import { IExchangeData, IDetailedPosition, IPositionDetailHyper, IAssetNameInfoHyper, IAssetDataContextHyper, IHyperliquidAccountInfo, ICombinedAssetCtxHyper } from '../../common/interfaces';

// Тип для полного ответа от запроса "metaAndAssetCtxs"
type MetaAndAssetCtxsResponse = [{ universe: IAssetNameInfoHyper[] }, IAssetDataContextHyper[]];

export class HyperliquidService {

    private readonly API_URL = 'https://api.hyperliquid.xyz/info';
    private readonly userAddress = process.env.ACCOUNT_HYPERLIQUID_ETH;

    constructor() {
        if (!this.userAddress) {
            throw new Error('Hyperliquid ACCOUNT_HYPERLIQUID_ETH must be provided in .env file');
        }
    }

    private getErrorMessage(error: unknown): string {
        if (error instanceof Error) {
            return error.message;
        }
        return String(error);
    }

    private async getAccountState(): Promise<IHyperliquidAccountInfo> {
        try {
            const response = await axios.post(this.API_URL, {
                type: 'clearinghouseState',
                user: this.userAddress,
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

    // --- Приватный Helper-метод ---
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

    // --- ОБНОВЛЕННЫЙ МЕТОД ---
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
}