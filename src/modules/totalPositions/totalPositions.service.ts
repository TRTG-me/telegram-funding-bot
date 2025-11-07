import { Injectable } from '@nestjs/common';
import { BinanceService } from '../binance/binance.service';
import { HyperliquidService } from '../hyperliquid/hyperliquid.service';
import { ParadexService } from '../paradex/paradex.service';
import { LighterService } from '../lighter/lighter.service';
import { ExtendedService } from '../extended/extended.service';
import { IDetailedPosition } from '../../common/interfaces';


export interface HedgedPair {
    coin: string;
    notional: number;
    size: number;
    exchanges: string;
    funding1: number; // Funding для LONG позиции
    funding2: number; // Funding для SHORT позиции
    fundingDiff: number;
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

@Injectable()
export class TotalPositionsService {
    constructor(
        private readonly binanceService: BinanceService,
        private readonly hyperliquidService: HyperliquidService,
        private readonly paradexService: ParadexService,
        private readonly lighterService: LighterService,
        private readonly extendedService: ExtendedService,
    ) { }

    public async getAggregatedPositions(): Promise<AggregatedPositions> {
        const allPositions = await this._fetchAllPositions();
        return this._findAndPairPositions(allPositions);
    }

    private async _fetchAllPositions(): Promise<IDetailedPosition[]> {
        const services = [this.binanceService, this.hyperliquidService, this.paradexService, this.lighterService, this.extendedService];
        const results = await Promise.allSettled(services.map(service => service.getDetailedPositions()));
        const allPositions: IDetailedPosition[] = [];
        results.forEach((result, index) => {
            if (result.status === 'fulfilled') {
                allPositions.push(...result.value);
            } else {
                console.error(`Failed to fetch positions from ${services[index].constructor.name}:`, result.reason);
            }
        });
        return allPositions;
    }

    private _findAndPairPositions(positions: IDetailedPosition[]): AggregatedPositions {
        const hedgedPairs: HedgedPair[] = [];
        const TOLERANCE = 1e-9;
        const formatFunding = (rate: number): number => parseFloat(rate.toFixed(4));
        const workingPositions = positions.map(p => ({ ...p, remainingSize: p.size }));
        const positionsByCoin = new Map<string, typeof workingPositions>();
        for (const pos of workingPositions) {
            if (!positionsByCoin.has(pos.coin)) {
                positionsByCoin.set(pos.coin, []);
            }
            positionsByCoin.get(pos.coin)!.push(pos);
        }

        for (const coinPositions of positionsByCoin.values()) {
            const longs = coinPositions.filter(p => p.side === 'L');
            const shorts = coinPositions.filter(p => p.side === 'S');

            for (const longPos of longs) {
                if (longPos.remainingSize < TOLERANCE) continue;

                for (const shortPos of shorts) {
                    if (shortPos.remainingSize < TOLERANCE) continue;

                    const matchSize = Math.min(longPos.remainingSize, shortPos.remainingSize);
                    longPos.remainingSize -= matchSize;
                    shortPos.remainingSize -= matchSize;


                    const longExchangeInfo = { name: longPos.exchange, funding: longPos.fundingRate };
                    const shortExchangeInfo = { name: shortPos.exchange, funding: shortPos.fundingRate };

                    const notional = (matchSize / longPos.size) * parseFloat(longPos.notional);

                    const pair: HedgedPair = {
                        coin: longPos.coin,
                        size: parseFloat(matchSize.toFixed(3)),
                        notional: parseFloat(Math.abs(notional).toFixed(1)),
                        // Первая биржа - всегда LONG, вторая - всегда SHORT
                        exchanges: `${longExchangeInfo.name}-${shortExchangeInfo.name}`,
                        // funding1 - всегда от LONG, funding2 - всегда от SHORT
                        funding1: formatFunding(longExchangeInfo.funding),
                        funding2: formatFunding(shortExchangeInfo.funding),
                        fundingDiff: parseFloat(((shortPos.fundingRate - longPos.fundingRate) * 3 * 365).toFixed(1)),
                    };
                    hedgedPairs.push(pair);

                    if (longPos.remainingSize < TOLERANCE) {
                        break;
                    }
                }
            }
        }

        const unhedgedPositions: UnhedgedPosition[] = workingPositions
            .filter(p => p.remainingSize > TOLERANCE)
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

        hedgedPairs.sort((a, b) => b.notional - a.notional);
        unhedgedPositions.sort((a, b) => b.notional - a.notional);

        return { hedgedPairs, unhedgedPositions };
    }
}