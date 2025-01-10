import { promises as fsPromises } from 'fs';
import path from "path";
import chalk from "chalk";
import { SystemSettings } from "./types.js";

const DEFAULT_SETTINGS: SystemSettings = {
  speeds: {
    front: 100,
    right: 100,
    back: 100,
    left: 100,
    lip: 100,
  },
  maintenance: {
    lastMaintenanceDate: new Date().toISOString().split("T")[0],
    maintenanceInterval: 30,
    primeTime: 5,
    cleanTime: 10,
    backWashTime: 15,
    pressurePotDelay: 5,
    positions: {
      prime: { x: 0, y: 15, angle: 135 },
      clean: { x: 0, y: 20, angle: 135 },
    }
  },
  serial: {
    baudRate: 115200,
    vendorIds: [
      "2341", // Arduino vendor ID
      "1a86", // CH340 chip vendor ID
    ],
    commonPaths: [
      "/dev/ttyACM0",  // Common Arduino path on Linux
      "/dev/ttyACM1",
      "/dev/ttyUSB0",
      "/dev/ttyUSB1",
      "/dev/tty.usbserial-210",
      "/dev/tty.usbmodem*" // For Arduino on macOS
    ]
  },
  pattern: {
    initialOffsets: {
      front: { x: 0, y: 0, angle: 0 },
      right: { x: 0, y: 0, angle: 0 },
      back: { x: 0, y: 0, angle: 0 },
      left: { x: 0, y: 0, angle: 0 },
      lip: { x: 0, y: 0, angle: 0 },
    },
    travelDistance: {
      horizontal: { x: 10, y: 0 },
      vertical: { x: 10, y: 2 },
      lip: { x: 4.415, y: 27.49 },
    },
    rows: {
      x: 6,
      y: 8,
    },
    enabledSides: {
      front: true,
      right: true,
      back: true,
      left: true,
      lip: true,
    },
  },
};

interface SavedConfig {
  name: string;
  description?: string;
  timestamp: string;
  settings: SystemSettings;
}

export class SettingsManager {
  private static instance: SettingsManager;
  private settings: SystemSettings;
  private readonly settingsPath: string;
  private readonly configsPath: string;

  private constructor() {
    this.settingsPath = path.join(process.cwd(), "settings.json");
    this.configsPath = path.join(process.cwd(), "saved_configs");
    this.settings = DEFAULT_SETTINGS;
  }

  static getInstance(): SettingsManager {
    if (!SettingsManager.instance) {
      SettingsManager.instance = new SettingsManager();
    }
    return SettingsManager.instance;
  }

  async initialize(): Promise<void> {
    try {
      await fsPromises.mkdir(this.configsPath, { recursive: true });
      
      const data = await fsPromises.readFile(this.settingsPath, "utf-8");
      this.settings = { ...DEFAULT_SETTINGS, ...JSON.parse(data) };
      console.log(chalk.green("✓ Settings loaded successfully"));
    } catch (error) {
      console.log(
        chalk.yellow("⚠ No settings file found, creating with defaults...")
      );
      await this.saveSettings();
    }
  }

  private async saveSettings(): Promise<void> {
    try {
      await fsPromises.writeFile(
        this.settingsPath,
        JSON.stringify(this.settings, null, 2),
        "utf-8"
      );
      console.log(chalk.green("✓ Settings saved successfully"));
    } catch (error) {
      console.error(chalk.red("❌ Error saving settings:"), error);
      throw error;
    }
  }

  async updateSpeeds(speeds: Partial<SystemSettings["speeds"]>): Promise<void> {
    this.settings.speeds = { ...this.settings.speeds, ...speeds };
    await this.saveSettings();
  }

  async updateMaintenanceDate(): Promise<void> {
    this.settings.maintenance.lastMaintenanceDate = new Date()
      .toISOString()
      .split("T")[0];
    await this.saveSettings();
  }

  async updateMaintenanceSettings(
    settings: Partial<SystemSettings["maintenance"]>
  ): Promise<void> {
    this.settings.maintenance = { ...this.settings.maintenance, ...settings };
    await this.saveSettings();
  }

  async updatePatternSettings(
    settings: Partial<SystemSettings["pattern"]>
  ): Promise<void> {
    this.settings.pattern = { ...this.settings.pattern, ...settings };
    await this.saveSettings();
  }

  getSettings(): SystemSettings {
    return { ...this.settings };
  }

  getSpeeds(): SystemSettings["speeds"] {
    return { ...this.settings.speeds };
  }

  getSerialConfig() {
    return { ...this.settings.serial };
  }

  getMaintenanceSettings() {
    return { ...this.settings.maintenance };
  }

  getPatternSettings() {
    return { ...this.settings.pattern };
  }

  async saveConfig(name: string, description?: string): Promise<void> {
    const config: SavedConfig = {
      name,
      description,
      timestamp: new Date().toISOString(),
      settings: { ...this.settings }
    };

    const filename = `${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}.json`;
    const filepath = path.join(this.configsPath, filename);

    try {
      await fsPromises.writeFile(filepath, JSON.stringify(config, null, 2));
      console.log(chalk.green(`✓ Configuration "${name}" saved successfully`));
    } catch (error) {
      console.error(chalk.red(`❌ Error saving configuration "${name}":`, error));
      throw error;
    }
  }

  async loadConfig(name: string): Promise<void> {
    const filename = `${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}.json`;
    const filepath = path.join(this.configsPath, filename);

    try {
      const data = await fsPromises.readFile(filepath, 'utf-8');
      const config: SavedConfig = JSON.parse(data);
      this.settings = { ...DEFAULT_SETTINGS, ...config.settings };
      await this.saveSettings();
      console.log(chalk.green(`✓ Configuration "${name}" loaded successfully`));
    } catch (error) {
      console.error(chalk.red(`❌ Error loading configuration "${name}":`, error));
      throw error;
    }
  }

  async listConfigs(): Promise<Array<{ name: string; description?: string; timestamp: string }>> {
    try {
      const files = await fsPromises.readdir(this.configsPath);
      const configs = await Promise.all(
        files
          .filter(file => file.endsWith('.json'))
          .map(async file => {
            const data = await fsPromises.readFile(
              path.join(this.configsPath, file),
              'utf-8'
            );
            const config: SavedConfig = JSON.parse(data);
            return {
              name: config.name,
              description: config.description,
              timestamp: config.timestamp
            };
          })
      );
      return configs;
    } catch (error) {
      console.error(chalk.red('❌ Error listing configurations:', error));
      throw error;
    }
  }
}
