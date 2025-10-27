// src/modules/hyperliquid/hyperliquid.service.ts

import axios from 'axios';
import { IExchangeData, IDetailedPosition } from '../../common/interfaces'

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
    leverage: number;
    accountEquity: number;
    // marginUsed: number;
    // // <-- Теперь это одно число, а не объект
    // openPositions: PositionDetail[];
}


export class HyperliquidService {

    private readonly API_URL = 'https://api.hyperliquid.xyz/info';

    private getErrorMessage(error: unknown): string {
        if (error instanceof Error) {
            return error.message;
        }
        return String(error);
    }
    private readonly userAddress = process.env.ACCOUNT_HYPERLIQUID_ETH;
    private async getAccountState(): Promise<HyperliquidAccountInfo> {
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

    public async getDetailedPositions(): Promise<IDetailedPosition[]> {
        try {
            // --- Шаг 1: Параллельно запрашиваем состояние аккаунта и данные по фандингу ---
            const [accountState, assetContexts] = await Promise.all([
                this.getAccountState(),
                this.getAssetContexts()
            ]);

            // --- Шаг 2: Проверяем, что необходимые данные получены ---
            if (!Array.isArray(accountState.assetPositions) || !assetContexts) {
                throw new Error('Incomplete or invalid data received from Hyperliquid API.');
            }

            // --- Шаг 3: Создаем карту для быстрого доступа к ставкам фандинга по названию монеты ---
            const fundingMap = new Map<string, string>(
                assetContexts.map(asset => [asset.name, asset.funding])
            );

            // --- Шаг 4: Фильтруем и преобразуем позиции в нужный формат ---
            const detailedPositions: IDetailedPosition[] = accountState.assetPositions
                // Оставляем только те позиции, у которых есть размер (szi) и он не равен нулю
                .filter(p => p.position && p.position.szi && parseFloat(p.position.szi) !== 0)
                // Преобразуем каждую отфильтрованную позицию в формат IDetailedPosition
                .map(p => {
                    const position = p.position;
                    // Мы уверены, что поля существуют после .filter()
                    const coin = position.coin!;
                    const szi = parseFloat(position.szi!);
                    const notional = position.positionValue!;

                    // Получаем часовую ставку фандинга из карты
                    const hourlyFundingRate = parseFloat(fundingMap.get(coin) || '0');

                    // Расчет фандинга:
                    // 1. API Hyperliquid отдает часовую ставку (например, 0.0001)
                    // 2. Умножаем на 8, чтобы привести к 8-часовому периоду
                    // 3. Умножаем на 100, чтобы получить проценты
                    const fundingRate = hourlyFundingRate * 8 * 100;

                    return {
                        coin: coin,
                        notional: notional,
                        size: Math.abs(szi), // 3. Размер позы по модулю
                        side: szi > 0 ? 'L' : 'S', // 4. 'L' для лонга, 'S' для шорта
                        exchange: 'H', // 5. 'H' для Hyperliquid
                        fundingRate: fundingRate, // 6. Рассчитанная ставка фандинга
                    };
                });

            return detailedPositions;

        } catch (err) {
            const message = this.getErrorMessage(err);
            console.error('Error fetching Hyperliquid detailed positions:', err);
            throw new Error(`Failed to get detailed positions from Hyperliquid: ${message}`);
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

    public async getAccountSummary(): Promise<IExchangeData> {
        try {
            const [accountState, assetContexts] = await Promise.all([
                this.getAccountState(),
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
                leverage,
                accountEquity: accountValue,
                // marginUsed,
                // leverage, // <-- Передаем одно число
                // openPositions,
            };

        } catch (err) {
            const message = this.getErrorMessage(err);
            console.error('Error during Hyperliquid account summary generation:', err);
            throw new Error(`Failed to get Hyperliquid account summary: ${message}`);
        }
    }
}