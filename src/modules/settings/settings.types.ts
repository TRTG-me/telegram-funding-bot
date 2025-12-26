export interface RankSettings {
    value: number;
    emoji: string;
}

export interface Settings {
    leverage: {
        green: RankSettings;
        yellow: RankSettings;
        red: RankSettings;
    };
    adl: {
        target: number;
        warn: number;
        trigger: number;
    };
}
