// src/modules/hyperliquid/hyperliquid.service.ts

import axios from 'axios';

// --- ИНТЕРФЕЙСЫ ---

// Тип для метаданных по одному активу (из первого массива 'universe')
interface AssetNameInfo {
    name: string;
}

// Тип для контекстных данных по одному активу
interface AssetDataContext {
    funding: string;
}

// Тип для полного ответа от запроса "metaAndAssetCtxs"
type MetaAndAssetCtxsResponse = [{ universe: AssetNameInfo[] }, AssetDataContext[]];

// Тип для "склеенных" данных по одному активу
interface CombinedAssetCtx {
    name: string;
    funding: string;
}

// Тип для ответа API 'clearinghouseState'
interface HyperliquidAccountInfo {
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
export interface PositionDetail {
    coin: string;
    side: 'Long' | 'Short';
    size: number;
    notionalValue: number;
    fundingRate: number; // Уже в процентах
}

// ИЗМЕНЕНИЕ: Полный объект с данными для контроллера теперь проще
export interface FullAccountSummary {
    accountValue: number;
    marginUsed: number;
    leverage: number; // <-- Теперь это одно число, а не объект
    openPositions: PositionDetail[];
}


export class HyperliquidService {
    private readonly API_URL = 'https://api.hyperliquid.xyz/info';

    private getErrorMessage(error: unknown): string {
        if (error instanceof Error) {
            return error.message;
        }
        return String(error);
    }

    private async getAccountState(userAddress: string): Promise<HyperliquidAccountInfo> {
        try {
            const response = await axios.post(this.API_URL, {
                type: 'clearinghouseState',
                user: userAddress,
            });
            return response.data || {};
        } catch (error) {
            const message = this.getErrorMessage(error);
            throw new Error(`Failed to fetch Hyperliquid account state: ${message}`);
        }
    }

    private async getAssetContexts(): Promise<CombinedAssetCtx[] | null> {
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

    // --- ЕДИНЫЙ ПУБЛИЧНЫЙ МЕТОД (УПРОЩЕННАЯ ВЕРСИЯ) ---

    public async getAccountSummary(userAddress: string): Promise<FullAccountSummary> {
        try {
            const [accountState, assetContexts] = await Promise.all([
                this.getAccountState(userAddress),
                this.getAssetContexts()
            ]);

            if (
                !accountState.marginSummary ||
                typeof accountState.marginSummary.accountValue !== 'string' ||
                typeof accountState.marginSummary.totalNtlPos !== 'string' ||
                typeof accountState.crossMaintenanceMarginUsed !== 'string' ||
                !Array.isArray(accountState.assetPositions) ||
                !assetContexts
            ) {
                throw new Error('Incomplete or invalid data received from Hyperliquid API.');
            }

            // Выполняем все вычисления
            const accountValue = parseFloat(accountState.marginSummary.accountValue);
            const marginUsed = parseFloat(accountState.crossMaintenanceMarginUsed);
            const totalNtlPos = parseFloat(accountState.marginSummary.totalNtlPos);

            if (isNaN(accountValue) || isNaN(marginUsed) || isNaN(totalNtlPos)) {
                throw new Error('Failed to parse financial data from API response.');
            }

            const denominator = accountValue - marginUsed;
            // ИЗМЕНЕНИЕ: Объявляем одну переменную для плеча
            let leverage = 0;

            if (denominator !== 0) {
                // ИЗМЕНЕНИЕ: УБРАН расчет totalPositionValue. Он больше не нужен.
                leverage = totalNtlPos / denominator;

                // ИЗМЕНЕНИЕ: Проверяем только одно значение
                if (!isFinite(leverage)) {
                    throw new Error('Leverage calculation resulted in a non-finite number.');
                }
            }

            // Обрабатываем и фильтруем позиции
            const universeMap = new Map<string, CombinedAssetCtx>(
                assetContexts.map(asset => [asset.name, asset])
            );

            const openPositions: PositionDetail[] = accountState.assetPositions
                .filter(p => parseFloat(p.position.szi || '0') !== 0)
                .map(p => {
                    const position = p.position;
                    const szi = parseFloat(position.szi || '0');
                    const assetData = universeMap.get(position.coin || '');

                    return {
                        coin: position.coin || 'Unknown',
                        side: szi > 0 ? 'Long' : 'Short',
                        size: szi,
                        notionalValue: Math.abs(parseFloat(position.positionValue || '0')),
                        fundingRate: parseFloat(assetData?.funding || '0') * 100,
                    };
                });

            // ИЗМЕНЕНИЕ: Собираем и возвращаем финальный, чистый объект с одним плечом
            return {
                accountValue,
                marginUsed,
                leverage, // <-- Передаем одно число
                openPositions,
            };

        } catch (err) {
            const message = this.getErrorMessage(err);
            console.error('Error during Hyperliquid account summary generation:', err);
            throw new Error(`Failed to get Hyperliquid account summary: ${message}`);
        }
    }
}