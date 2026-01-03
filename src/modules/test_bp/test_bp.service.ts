import { Injectable, Logger } from '@nestjs/common';
import { LighterService } from '../lighter/lighter.service';
import { TestBpSession } from './test_bp.session';
import { ExchangeName } from '../bp/bp.types';
import { TestBpResult } from './test_bp.types';

@Injectable()
export class TestBpService {
    private readonly logger = new Logger(TestBpService.name);
    private sessions = new Map<number, TestBpSession>();

    constructor(
        private readonly lighterDataService: LighterService
    ) { }

    public async startTestSession(
        userId: number,
        coin: string,
        longExchange: ExchangeName,
        shortExchange: ExchangeName,
        onFinished: (result: TestBpResult | null) => void
    ): Promise<void> {
        this.stopSession(userId);

        const session = new TestBpSession(userId, this.lighterDataService);
        this.sessions.set(userId, session);

        try {
            await session.start(coin, longExchange, shortExchange, (result) => {
                this.sessions.delete(userId);
                onFinished(result);
            });
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
            this.logger.log(`Test BP session stopped for user ${userId}`);
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
