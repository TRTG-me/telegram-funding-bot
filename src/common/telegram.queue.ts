export class TelegramQueue {
    private queue: Array<{
        fn: () => Promise<void>;
        priority: number;
    }> = [];
    private processing = false;
    private messagesSent = 0;
    private lastResetTime = Date.now();

    // Telegram лимит: 30 msg/sec
    private readonly MAX_MESSAGES_PER_SECOND = 28; // Запас
    private readonly DELAY_BETWEEN_MESSAGES = 1000 / this.MAX_MESSAGES_PER_SECOND; // ~35ms

    async add(fn: () => Promise<void>, priority: number = 0) {
        this.queue.push({ fn, priority });

        // Сортируем по приоритету (высокий приоритет первым)
        this.queue.sort((a, b) => b.priority - a.priority);

        if (!this.processing) {
            this.process();
        }
    }

    private async process() {
        this.processing = true;

        while (this.queue.length > 0) {
            // Сброс счетчика каждую секунду
            const now = Date.now();
            if (now - this.lastResetTime > 1000) {
                this.messagesSent = 0;
                this.lastResetTime = now;
            }

            // Если достигли лимита, ждем до следующей секунды
            if (this.messagesSent >= this.MAX_MESSAGES_PER_SECOND) {
                const waitTime = 1000 - (now - this.lastResetTime);
                await new Promise(r => setTimeout(r, waitTime));
                this.messagesSent = 0;
                this.lastResetTime = Date.now();
            }

            const item = this.queue.shift()!;

            try {
                await item.fn();
                this.messagesSent++;
            } catch (e: any) {
                console.error('[TelegramQueue] Error:', e.message);

                // Если 429, ждем 5 секунд
                if (e.description?.includes('Too Many Requests')) {
                    console.warn('[TelegramQueue] Rate limit hit! Waiting 5 sec...');
                    await new Promise(r => setTimeout(r, 5000));
                    this.messagesSent = 0;
                    this.lastResetTime = Date.now();
                }
            }

            // Задержка между сообщениями
            await new Promise(r => setTimeout(r, this.DELAY_BETWEEN_MESSAGES));
        }

        this.processing = false;
    }

    getQueueSize(): number {
        return this.queue.length;
    }
}

// Глобальный экземпляр
export const telegramQueue = new TelegramQueue();
