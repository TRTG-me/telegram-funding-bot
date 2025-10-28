// src/modules/totalPositions/totalPositions.service.ts

import { Injectable } from '@nestjs/common';
import { BinanceService } from '../binance/binance.service';
import { HyperliquidService } from '../hyperliquid/hyperliquid.service';
import { ParadexService } from '../paradex/paradex.service';
import { LighterService } from '../lighter/lighter.service';
import { ExtendedService } from '../extended/extended.service';
import { IDetailedPosition } from '../../common/interfaces';

// =================================================================
// ИНТЕРФЕЙСЫ ДЛЯ ВЫХОДНЫХ ДАННЫХ
// =================================================================

export interface HedgedPair {
    coin: string;
    notional: number;
    size: number;
    exchanges: string; // e.g., 'BH', 'HP'
    funding1: number;
    funding2: number;
    fundingDiff: number; // Рассчитывается как: fundingRate(SHORT) - fundingRate(LONG)
}

export interface UnhedgedPosition {
    coin: string;
    notional: number;
    size: number;
    side: 'LONG' | 'SHORT';
    exchange: string;
    fundingRate: number;
}

export interface AggregatedPositions {
    hedgedPairs: HedgedPair[];
    unhedgedPositions: UnhedgedPosition[];
}

// =================================================================
// СЕРВИС-АГРЕГАТОР
// =================================================================

@Injectable()
export class TotalPositionsService {
    // Внедряем все сервисы бирж через конструктор (стандартный паттерн для NestJS)
    constructor(
        private readonly binanceService: BinanceService,
        private readonly hyperliquidService: HyperliquidService,
        private readonly paradexService: ParadexService,
        private readonly lighterService: LighterService,
        private readonly extendedService: ExtendedService,
    ) { }

    /**
     * Основной публичный метод. Собирает данные со всех бирж, находит и возвращает пары и одиночные позиции.
     */
    public async getAggregatedPositions(): Promise<AggregatedPositions> {
        // Шаг 1: Асинхронно и надежно получаем все позиции со всех бирж.
        const allPositions = await this._fetchAllPositions();

        // Шаг 2: Запускаем основной алгоритм для поиска пар и остатков.
        return this._findAndPairPositions(allPositions);
    }

    /**
     * Параллельно запрашивает позиции со всех бирж, используя Promise.allSettled для надежности.
     * Если API одной биржи не ответит, мы продолжим работу с данными от остальных.
     */
    private async _fetchAllPositions(): Promise<IDetailedPosition[]> {
        const services = [
            this.binanceService,
            this.hyperliquidService,
            this.paradexService,
            this.lighterService,
            this.extendedService,
        ];

        const results = await Promise.allSettled(
            services.map(service => service.getDetailedPositions())
        );

        const allPositions: IDetailedPosition[] = [];
        results.forEach((result, index) => {
            if (result.status === 'fulfilled') {
                allPositions.push(...result.value);
            } else {
                const serviceName = services[index].constructor.name;
                console.error(`Failed to fetch positions from ${serviceName}:`, result.reason);
            }
        });

        return allPositions;
    }

    /**
     * Основной алгоритм для сопоставления лонг и шорт позиций.
     * @param positions - Плоский массив всех позиций со всех бирж.
     */
    private _findAndPairPositions(positions: IDetailedPosition[]): AggregatedPositions {
        const hedgedPairs: HedgedPair[] = [];
        const TOLERANCE = 1e-9; // Небольшая погрешность для сравнения чисел с плавающей точкой
        const formatFunding = (rate: number): number => parseFloat(rate.toFixed(4));

        // Создаем рабочую копию позиций. Мы будем уменьшать 'remainingSize' по мере нахождения пар.
        const workingPositions = positions.map(p => ({ ...p, remainingSize: p.size }));

        // Группируем все позиции по монетам для эффективной обработки
        const positionsByCoin = new Map<string, typeof workingPositions>();
        for (const pos of workingPositions) {
            if (!positionsByCoin.has(pos.coin)) {
                positionsByCoin.set(pos.coin, []);
            }
            positionsByCoin.get(pos.coin)!.push(pos);
        }

        // Обрабатываем каждую монету отдельно
        for (const coinPositions of positionsByCoin.values()) {
            const longs = coinPositions.filter(p => p.side === 'L');
            const shorts = coinPositions.filter(p => p.side === 'S');

            // Главный цикл: пытаемся найти шорт для каждого лонга
            for (const longPos of longs) {
                if (longPos.remainingSize < TOLERANCE) continue; // Этот лонг уже полностью распределен

                for (const shortPos of shorts) {
                    if (shortPos.remainingSize < TOLERANCE) continue; // Этот шорт уже полностью распределен

                    // Находим минимальный размер для сопоставления (матчинга)
                    const matchSize = Math.min(longPos.remainingSize, shortPos.remainingSize);

                    // Уменьшаем "оставшийся" размер для обеих позиций
                    longPos.remainingSize -= matchSize;
                    shortPos.remainingSize -= matchSize;

                    // --- Создаем объект хеджированной пары ---

                    // Сортируем биржи по алфавиту, чтобы 'BH' и 'HB' считались одной парой 'BH'
                    const exchangesSorted = [
                        { name: longPos.exchange, funding: longPos.fundingRate },
                        { name: shortPos.exchange, funding: shortPos.fundingRate },
                    ].sort((a, b) => a.name.localeCompare(b.name));

                    // Рассчитываем номинальную стоимость для этой части позиции
                    // (пропорционально от оригинальной стоимости)
                    const notional = (matchSize / longPos.size) * parseFloat(longPos.notional);

                    const pair: HedgedPair = {
                        coin: longPos.coin,
                        size: parseFloat(matchSize.toFixed(3)),
                        notional: parseFloat(Math.abs(notional).toFixed(1)), // Округляем для чистоты
                        exchanges: exchangesSorted.map(e => e.name).join('-'), // e.g., 'BH'
                        funding1: formatFunding(exchangesSorted[0].funding),
                        funding2: formatFunding(exchangesSorted[1].funding),
                        // Ключевой расчет: Фандинг(ШОРТ) - Фандинг(ЛОНГ)
                        fundingDiff: parseFloat(((shortPos.fundingRate - longPos.fundingRate) * 3 * 365).toFixed(1)),
                    };
                    hedgedPairs.push(pair);

                    if (longPos.remainingSize < TOLERANCE) {
                        // Если от лонга ничего не осталось, переходим к следующему лонгу
                        break;
                    }
                }
            }
        }

        // --- Собираем все нераспределенные остатки ---
        const unhedgedPositions: UnhedgedPosition[] = workingPositions
            .filter(p => p.remainingSize > TOLERANCE) // Оставляем только те, где остался размер
            .map(p => {
                const notional = (p.remainingSize / p.size) * parseFloat(p.notional);
                return {
                    coin: p.coin,
                    size: parseFloat(p.remainingSize.toFixed(3)),
                    notional: parseFloat(Math.abs(notional).toFixed(1)),
                    side: p.side === 'L' ? 'LONG' : 'SHORT',
                    exchange: p.exchange,
                    fundingRate: parseFloat(((p.fundingRate) * 3 * 365).toFixed(0)),
                };
            });

        return { hedgedPairs, unhedgedPositions };
    }
}