import { Injectable, Logger } from '@nestjs/common';
import { LighterService } from '../lighter/lighter.service';
import { BpSession } from './bp.session';
// ИЗМЕНЕНИЕ ЗДЕСЬ: Импорт типов
import { ExchangeName, BpCalculationData } from './bp.types';

// Тип колбэка для контроллера
export type SessionUpdateCallback = (userId: number, data: BpCalculationData | null) => void;

@Injectable()
export class BpService {
    private readonly logger = new Logger(BpService.name);

    // Карта активных сессий: UserId -> Session
    private sessions = new Map<number, BpSession>();

    constructor(
        private readonly lighterDataService: LighterService
    ) { }

    public async startSession(
        userId: number,
        coin: string,
        longExchange: ExchangeName,
        shortExchange: ExchangeName,
        onUpdate: (data: BpCalculationData | null) => void
    ): Promise<void> {
        this.stopSession(userId);

        const session = new BpSession(userId, this.lighterDataService);
        this.sessions.set(userId, session);

        try {
            await session.start(coin, longExchange, shortExchange, onUpdate);
        } catch (e) {
            this.sessions.delete(userId);
            throw e;
        }
    }

    public stopSession(userId: number): void {
        const session = this.sessions.get(userId);
        if (session) {
            session.stop();
            this.sessions.delete(userId);
            this.logger.log(`Session stopped for user ${userId}`);
        }
    }

    public isSessionActive(userId: number): boolean {
        return this.sessions.has(userId);
    }

    public stopAll() {
        for (const userId of this.sessions.keys()) {
            this.stopSession(userId);
        }
    }
}