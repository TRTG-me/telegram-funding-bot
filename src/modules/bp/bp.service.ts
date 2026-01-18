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

    // Карта активных сессий: "UserId:Tag" -> Session
    private sessions = new Map<string, BpSession>();

    constructor(
        private readonly lighterDataService: LighterService
    ) { }

    public async startSession(
        userId: number,
        coin: string,
        longExchange: ExchangeName,
        shortExchange: ExchangeName,
        onUpdate: (data: BpCalculationData | null) => void,
        tag: string = 'default'
    ): Promise<void> {
        const sessionKey = `${userId}:${tag}`;
        this.stopSession(userId, tag);

        const session = new BpSession(userId, this.lighterDataService);
        this.sessions.set(sessionKey, session);

        try {
            await session.start(coin, longExchange, shortExchange, onUpdate);
        } catch (e) {
            this.sessions.delete(sessionKey);
            throw e;
        }
    }

    public stopSession(userId: number, tag: string = 'default'): void {
        const sessionKey = `${userId}:${tag}`;
        const session = this.sessions.get(sessionKey);
        if (session) {
            session.stop();
            this.sessions.delete(sessionKey);
            this.logger.log(`Session stopped for user ${userId} (tag: ${tag})`);
        }
    }

    public isSessionActive(userId: number, tag: string = 'default'): boolean {
        return this.sessions.has(`${userId}:${tag}`);
    }

    public stopAll() {
        for (const key of this.sessions.keys()) {
            const [userIdStr, tag] = key.split(':');
            this.stopSession(parseInt(userIdStr), tag);
        }
    }

    public stopAllUserSessions(userId: number): void {
        for (const key of this.sessions.keys()) {
            if (key.startsWith(`${userId}:`)) {
                const tag = key.split(':')[1];
                this.stopSession(userId, tag);
            }
        }
    }
}