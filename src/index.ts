#!/usr/bin/env node
import { SerialPort } from "serialport";
import { ReadlineParser } from "@serialport/parser-readline";
import { WebSocket, WebSocketServer } from "ws";
import chalk from "chalk";
import { CommandExecutor } from "./CommandExecutor.js";
import { SettingsManager } from "./SettingsManager.js";

type PatternEventType =
  | "PATTERN_START"
  | "PATTERN_COMPLETE"
  | "PATTERN_STOPPED"
  | "SIDE_COMPLETE"
  | "SIDE_CHANGE"
  | "SPRAY_COMPLETE"
  | "SPRAY_START"
  | "VERTICAL_MOVE"
  | "PROGRESS"
  | "ERROR"
  | "MOVE_X"
  | "MOVE_Y"
  | "PRESSURE_POT_STATUS"; // New event type

interface PatternStatus {
  command: number;
  total_commands: number;
  total_rows: number;
  row: number;
  pattern: string;
  single_side: boolean;
  details?: string;
  completed_rows: [];
  duration: number;
  axis?: "X" | "Y";
}

// Update the SystemState interface
interface SystemState {
  status:
    | "IDLE"
    | "HOMING_X"
    | "HOMING_Y"
    | "HOMING_ROTATION"
    | "HOMED"
    | "DEPRESSURIZE_POT"
    | "STOPPED"
    | "PAUSED"
    | "EXECUTING_PATTERN"
    | "ERROR"
    | "CYCLE_COMPLETE"
    | "CLEANING"
    | "PAINTING_SIDE"
    | "MANUAL_ROTATING"
    | "UNKNOWN";
  position: {
    x: number;
    y: number;
  };
  systemInfo: {
    temperature: number;
    uptime: string;
    lastMaintenance: string;
  };
  patternProgress: PatternStatus;
  lastSerialMessage: string;
  pressurePotActive: boolean;
}

interface SerialConfig {
  path: string;
  baudRate: number;
}

class PaintSystemController {
  private port: SerialPort | null = null;
  private parser: ReadlineParser | null = null;
  private wss: WebSocketServer | null = null;
  private clients: Set<WebSocket> = new Set();
  private uptimeStart: Date = new Date();
  private reconnectAttempts: number = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 5;
  private reconnectTimer: NodeJS.Timeout | null = null;

  private status: SystemState = {
    status: "IDLE",
    position: { x: 0, y: 0 },
    systemInfo: {
      temperature: 24,
      uptime: "0d 0h 0m",
      lastMaintenance: new Date().toISOString().split("T")[0],
    },
    lastSerialMessage: "",
    patternProgress: {
      command: 0,
      total_commands: 0,
      row: 0,
      pattern: "",
      single_side: false,
      completed_rows: [],
      total_rows: 9,
      duration: 0,
    },
    pressurePotActive: false,
  };

  constructor(private config: SerialConfig) {}

  async initialize(): Promise<void> {
    await this.initializeSerial();
    this.initializeWebSocket();
    this.startUptimeTimer();

    // Load and send initial speeds to the slave
    const settings = SettingsManager.getInstance();
    const speeds = settings.getSpeeds();

    // Send each speed setting to the slave
    for (const [side, value] of Object.entries(speeds)) {
      await this.sendSerialCommand(`SPEED ${side.toUpperCase()} ${value}`);
    }

    // Initialize pattern configuration
    const patternConfig = settings.getPatternSettings();

    // Send pattern configuration to the ESP32
    await this.sendSerialCommand(
      `SET_OFFSET_X ${patternConfig.offsets.x.toFixed(2)}`
    );
    await this.sendSerialCommand(
      `SET_OFFSET_Y ${patternConfig.offsets.y.toFixed(2)}`
    );
    await this.sendSerialCommand(
      `SET_TRAVEL_X ${patternConfig.travelDistance.x.toFixed(2)}`
    );
    await this.sendSerialCommand(
      `SET_TRAVEL_Y ${patternConfig.travelDistance.y.toFixed(2)}`
    );
    await this.sendSerialCommand(
      `SET_GRID ${patternConfig.rows.x} ${patternConfig.rows.y}`
    );
  }

  private async initializeSerial(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.port = new SerialPort(
        {
          path: this.config.path,
          baudRate: this.config.baudRate,
        },
        (err) => {
          if (err) {
            const errorMessage = `Failed to open port ${this.config.path}: ${err.message}`;
            console.error(chalk.red("🔌 USB Connection Error:"), errorMessage);
            this.broadcastToAll({
              type: "WARNING",
              payload: {
                title: "Connection Error",
                message: errorMessage,
                severity: "high",
              },
            });
            reject(new Error(errorMessage));
            return;
          }

          console.log(
            chalk.green("🔌 USB Connected successfully to"),
            chalk.bold(this.config.path)
          );
          this.reconnectAttempts = 0; // Reset reconnect attempts on successful connection
          this.parser = this.port!.pipe(
            new ReadlineParser({ delimiter: "\n" })
          );
          this.setupSerialHandlers();
          resolve();
        }
      );
    });
  }

  private initializeWebSocket(): void {
    this.wss = new WebSocketServer({ port: 8080 });

    this.wss.on("connection", (ws: WebSocket) => {
      console.log(chalk.green("🔌 New client connected"));
      this.clients.add(ws);

      // Send initial status
      this.sendStatusUpdate(ws);

      // Send initial settings
      this.sendSettingsUpdate(ws);

      ws.on("message", async (message: string) => {
        try {
          const command = JSON.parse(message.toString());
          await this.handleWebSocketCommand(command, ws);
        } catch (error) {
          console.error(chalk.red("Error handling message:"), error);
          this.sendErrorToClient(ws, "Invalid command format");
        }
      });

      ws.on("close", () => {
        console.log(chalk.yellow("🔌 Client disconnected"));
        this.clients.delete(ws);
      });

      ws.on("error", (error) => {
        console.error(chalk.red("WebSocket error:"), error);
        this.clients.delete(ws);
      });
    });
  }

  private setupSerialHandlers(): void {
    if (!this.parser || !this.port) return;

    this.parser.on("data", (line: string) => {
      this.processSerialResponse(line.trim());
    });

    this.port.on("error", (error) => {
      console.error(chalk.red("🔌 Serial port error:"), error);
      this.updateStatus({ status: "ERROR" });
      this.broadcastToAll({
        type: "WARNING",
        payload: {
          title: "Serial Port Error",
          message: `Serial communication error: ${error.message}`,
          severity: "high",
        },
      });
    });

    this.port.on("close", () => {
      const disconnectMessage = "USB connection closed";
      console.log(chalk.yellow("🔌 USB Disconnected:"), disconnectMessage);

      this.updateStatus({ status: "ERROR" });
      this.broadcastToAll({
        type: "WARNING",
        payload: {
          title: "USB Disconnected",
          message: disconnectMessage,
          severity: "high",
        },
      });

      // Attempt to reconnect
      this.handleDisconnect();
    });
  }

  private handleDisconnect(): void {
    // Clear any existing reconnect timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    if (this.reconnectAttempts < this.MAX_RECONNECT_ATTEMPTS) {
      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000); // Exponential backoff with 30s max
      this.reconnectAttempts++;

      console.log(
        chalk.yellow("🔄 Attempting to reconnect:"),
        chalk.bold(
          `Attempt ${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS}`
        ),
        chalk.gray(`(waiting ${delay / 1000}s)`)
      );

      this.reconnectTimer = setTimeout(async () => {
        try {
          await this.initializeSerial();
          console.log(chalk.green("✓ USB Reconnection successful"));
        } catch (error) {
          console.error(
            chalk.red("❌ Reconnection failed:"),
            chalk.gray(
              `(Attempt ${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS})`
            )
          );
          this.handleDisconnect(); // Try again if we haven't hit the limit
        }
      }, delay);
    } else {
      console.error(
        chalk.red("❌ Maximum reconnection attempts reached."),
        chalk.gray("Please check the USB connection and restart the system.")
      );
      this.broadcastToAll({
        type: "WARNING",
        payload: {
          title: "Connection Failed",
          message:
            "Maximum reconnection attempts reached. Please check the USB connection and restart the system.",
          severity: "high",
        },
      });
    }
  }

  private parseStatusMessage(
    line: string
  ): { eventType: PatternEventType; status: PatternStatus } | null {
    // Parse status message in format: EVENT_TYPE|key1=value1|key2=value2
    const parts = line.split("|");
    if (parts.length < 2) return null;

    const eventType = parts[0] as PatternEventType;
    const status: Partial<PatternStatus> = {};

    // Parse key-value pairs
    for (let i = 1; i < parts.length; i++) {
      const [key, value] = parts[i].split("=");
      switch (key) {
        case "command":
          status.command = parseInt(value);
          break;
        case "total_commands":
          status.total_commands = parseInt(value);
          break;
        case "row":
          status.row = parseInt(value);
          break;
        case "pattern":
          status.pattern = value;
          break;
        case "single_side":
          status.single_side = value === "true";
          break;
        case "details":
          status.details = value;
          break;
        case "duration_ms":
          status.duration = Number.parseInt(value);
          break;
        case "movement_axis":
          status.axis = value ? (value == "X" ? "X" : "Y") : undefined;
          break;
      }
    }

    // console.log(chalk.red(JSON.stringify(status)));

    return {
      eventType,
      status: status as PatternStatus,
    };
  }

  private processSerialResponse(line: string): void {
    // Store the raw serial message
    this.status.lastSerialMessage = line;

    // Log raw input with timestamp
    const timestamp = new Date().toISOString();
    console.log(
      chalk.gray(`[${timestamp}]`),
      chalk.cyan("📟 Raw serial data:"),
      chalk.bold(line)
    );

    if (line.startsWith("Pressure pot")) {
      const isActive = !line.includes("deactivated");
      this.updateStatus({ pressurePotActive: isActive });
    }

    // Handle state changes
    if (line.startsWith("State changed:")) {
      const state = line.split(":")[1].trim();
      console.log(
        chalk.gray("└─"),
        chalk.magenta("State Change:"),
        chalk.bold(state)
      );

      switch (state) {
        case "HOMED":
          this.updateStatus({
            status: "HOMED",
            patternProgress: {
              command: 0,
              total_commands: 0,
              row: 0,
              total_rows: 9,
              completed_rows: [],
              single_side: false,
              pattern: "",
              duration: 0,
              axis: undefined,
            },
          });
          break;
        case "IDLE":
        case "HOMING_X":
        case "HOMING_Y":
        case "HOMING_ROTATION":
        case "STOPPED":
        case "PAUSED":
        case "EXECUTING_PATTERN":
        case "ERROR":
        case "CYCLE_COMPLETE":
        case "CLEANING":
        case "PAINTING_SIDE":
        case "MANUAL_ROTATING":
        case "PRIMING":
          this.updateStatus({ status: state as SystemState["status"] });
          break;
        default:
          this.updateStatus({ status: "UNKNOWN" });
      }
      return;
    }

    // Try to parse as a structured status message
    const parsedStatus = this.parseStatusMessage(line);
    if (parsedStatus) {
      const { eventType, status } = parsedStatus;

      // Update system status based on event type
      switch (eventType) {
        case "PATTERN_START":
          this.updateStatus({
            status: "EXECUTING_PATTERN",
            patternProgress: {
              ...this.status.patternProgress,
              command: status.command,
              total_commands: status.total_commands,
              row: status.row - 1,
              single_side: status.single_side,
              pattern: status.pattern,
            },
          });
          break;

        case "PATTERN_COMPLETE":
          this.updateStatus({
            status: status.single_side ? "IDLE" : "HOMED",
            patternProgress: {
              ...this.status.patternProgress,
              command: 0,
              completed_rows: [],
            },
          });
          break;

        case "SPRAY_COMPLETE":
          const updatedCompletedRows = [
            ...this.status.patternProgress.completed_rows,
          ];
          //@ts-ignore

          if (!updatedCompletedRows.includes(status.row - 1)) {
            //@ts-ignore

            updatedCompletedRows.push(status.row - 1);
          }
          this.updateStatus({
            patternProgress: {
              ...this.status.patternProgress,
              //@ts-ignore
              completed_rows: updatedCompletedRows,
            },
          });
          break;

        case "SPRAY_START":
          this.updateStatus({
            patternProgress: {
              ...this.status.patternProgress,
              row: status.row - 1,
            },
          });
          break;

        case "MOVE_X":
          this.updateStatus({
            patternProgress: {
              ...this.status.patternProgress,
              command: status.command,
              total_commands: status.total_commands,
              row: status.row - 1,
              single_side: status.single_side,
              pattern: status.pattern,
              axis: status.axis,
              duration: status.duration,
            },
          });
          break;

        case "MOVE_Y":
          this.updateStatus({
            patternProgress: {
              ...this.status.patternProgress,
              command: status.command,
              total_commands: status.total_commands,
              row: status.row - 1,
              single_side: status.single_side,
              pattern: status.pattern,
              axis: status.axis,
              duration: status.duration,
            },
          });
          break;

        case "ERROR":
          this.updateStatus({
            status: "ERROR",
          });
          this.broadcastToAll({
            type: "WARNING",
            payload: {
              title: "Error",
              message: status.details || "Unknown error occurred",
              severity: "high",
            },
          });
          break;
      }

      return;
    }

    // Process other types of messages (position updates, temperature, etc.)
    if (line.startsWith("Position:")) {
      const [x, y] = line.split(":")[1].trim().split(",").map(Number);
      this.updateStatus({ position: { x, y } });
    }

    // Rest of your existing response handling
    else if (line.startsWith("Position:")) {
      const [x, y] = line.split(":")[1].trim().split(",").map(Number);
      console.log(
        chalk.gray("└─"),
        chalk.blue("Position Update:"),
        chalk.bold(`X: ${x}, Y: ${y}`)
      );
      this.updateStatus({ position: { x, y } });
    } else if (line.startsWith("Temperature:")) {
      const temp = parseFloat(line.split(":")[1].trim());
      console.log(
        chalk.gray("└─"),
        chalk.red("Temperature:"),
        chalk.bold(`${temp.toFixed(1)}°C`)
      );
      this.updateStatus({
        systemInfo: {
          ...this.status.systemInfo,
          temperature: temp,
        },
      });
    } else if (line.startsWith("WARNING:")) {
      const warningMessage = line.trim().substring(9);
      console.log(
        chalk.gray("└─"),
        chalk.yellow("⚠ WARNING:"),
        chalk.bold(warningMessage)
      );
      this.broadcastToAll({
        type: "WARNING",
        payload: {
          title: "WARNING",
          message: warningMessage,
          severity: "low",
        },
      });
    }
  }

  // Update the handleWebSocketCommand method in PaintSystemController class
  private async handleWebSocketCommand(
    command: any,
    ws: WebSocket
  ): Promise<void> {
    console.log(chalk.blue("📥 Received command:"), command);

    try {
      switch (command.type) {
        case "START_PAINTING":
          await this.sendSerialCommand("START");
          break;
        case "STOP_PAINTING":
          await this.sendSerialCommand("STOP");
          break;
        case "HOME_SYSTEM":
          await this.sendSerialCommand("HOME");
          this.updateStatus({
            patternProgress: {
              command: 0,
              total_commands: 0,
              row: 0,
              total_rows: 9,
              completed_rows: [],
              single_side: false,
              pattern: "FRONT",
              duration: 0,
              axis: undefined,
            },
          });
          break;

        // Maintenance commands
        case "PRIME_GUN":
          const primeSettings =
            SettingsManager.getInstance().getMaintenanceSettings();
          await this.sendSerialCommand(`PRIME`);
          break;
        case "CLEAN_GUN":
          const cleanSettings =
            SettingsManager.getInstance().getMaintenanceSettings();
          await this.sendSerialCommand(`CLEAN`);
          break;
        case "TOGGLE_PRESSURE_POT":
          await this.sendSerialCommand("PRESSURE");
          break;

        // Single side painting commands
        case "PAINT_FRONT":
          await this.sendSerialCommand("FRONT");
          break;
        case "PAINT_RIGHT":
          await this.sendSerialCommand("RIGHT");
          break;
        case "PAINT_BACK":
          await this.sendSerialCommand("BACK");
          break;
        case "PAINT_LEFT":
          await this.sendSerialCommand("LEFT");
          break;
        case "ROTATE_SPINNER":
          await this.sendSerialCommand(
            `ROTATE ${command.payload.direction == "right" ? "" : "-"}${
              command.payload.degrees
            }`
          );
          break;

        // Single piece painting
        case "PAINT_PIECE":
          if (
            command.payload &&
            typeof command.payload.row === "number" &&
            typeof command.payload.col === "number"
          ) {
            // Validate the grid position
            if (
              command.payload.row >= 0 &&
              command.payload.row < 6 &&
              command.payload.col >= 0 &&
              command.payload.col < 9
            ) {
              await this.sendSerialCommand(
                `PAINT_PIECE ${command.payload.row} ${command.payload.col}`
              );
            } else {
              this.sendErrorToClient(
                ws,
                "Invalid grid position. Row must be 0-5 and column must be 0-8."
              );
            }
          } else {
            this.sendErrorToClient(
              ws,
              "Missing or invalid row/column in PAINT_PIECE command"
            );
          }
          break;

        case "SET_SPEED":
          if (
            command.payload &&
            command.payload.side &&
            command.payload.value
          ) {
            const settings = SettingsManager.getInstance();
            await settings.updateSpeeds({
              [command.payload.side]: command.payload.value,
            });

            // Send commands to ESP32
            await this.sendSerialCommand(
              `SPEED ${command.payload.side.toUpperCase()} ${
                command.payload.value
              }`
            );
          }
          break;

        case "MOVE":
          if (
            command.payload &&
            command.payload.axis &&
            command.payload.distance
          ) {
            const axis = command.payload.axis.toUpperCase();
            const distance = command.payload.distance;
            await this.sendSerialCommand(`MOVE_${axis} ${distance}`);
          }
          break;

        case "GOTO":
          if (
            command.payload &&
            command.payload.axis &&
            command.payload.position
          ) {
            const axis = command.payload.axis.toUpperCase();
            const position = command.payload.position;
            await this.sendSerialCommand(`GOTO_${axis} ${position}`);
          }
          break;

        case "HEARTBEAT":
          this.sendStatusUpdate(ws);
          break;

        case "SET_PRIME_TIME":
          if (command.payload && typeof command.payload.seconds === "number") {
            const seconds = Math.max(1, Math.min(30, command.payload.seconds)); // Limit between 1-30 seconds
            const settings = SettingsManager.getInstance();
            await settings.updateMaintenanceSettings({
              primeTime: seconds,
            });
            await this.sendSerialCommand(`PRIME_TIME ${seconds}`);
          }
          break;

        case "SET_CLEAN_TIME":
          if (command.payload && typeof command.payload.seconds === "number") {
            const seconds = Math.max(1, Math.min(60, command.payload.seconds)); // Limit between 1-60 seconds
            const settings = SettingsManager.getInstance();
            await settings.updateMaintenanceSettings({
              cleanTime: seconds,
            });
            await this.sendSerialCommand(`CLEAN_TIME ${seconds}`);
          }
          break;

        case "UPDATE_PATTERN_CONFIG":
          if (command.payload) {
            const settings = SettingsManager.getInstance();
            await settings.updatePatternSettings(command.payload);

            // Send the updated configuration to the ESP32
            const patternConfig = settings.getPatternSettings();

            // Send settings to all connected clients
            this.broadcastToAll({
              type: "SETTINGS_UPDATE",
              payload: {
                pattern: patternConfig,
                maintenance: settings.getMaintenanceSettings(),
                speeds: settings.getSpeeds(),
              },
            });

            // Send commands to ESP32
            await this.sendSerialCommand(
              `SET_OFFSET_X ${patternConfig.offsets.x.toFixed(2)}`
            );
            await this.sendSerialCommand(
              `SET_OFFSET_Y ${patternConfig.offsets.y.toFixed(2)}`
            );
            await this.sendSerialCommand(
              `SET_TRAVEL_X ${patternConfig.travelDistance.x.toFixed(2)}`
            );
            await this.sendSerialCommand(
              `SET_TRAVEL_Y ${patternConfig.travelDistance.y.toFixed(2)}`
            );
            await this.sendSerialCommand(
              `SET_GRID ${patternConfig.rows.x} ${patternConfig.rows.y}`
            );
          }
          break;

        case "GET_PATTERN_CONFIG":
          const patternSettings =
            SettingsManager.getInstance().getPatternSettings();
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: "PATTERN_CONFIG",
                payload: patternSettings,
              })
            );
          }
          break;

        case "GET_SETTINGS":
          const settings = SettingsManager.getInstance();
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: "SETTINGS_UPDATE",
                payload: {
                  pattern: settings.getPatternSettings(),
                  maintenance: settings.getMaintenanceSettings(),
                  speeds: settings.getSpeeds(),
                },
              })
            );
          }
          break;

        case "UPDATE_SETTINGS":
          if (command.payload) {
            const settings = SettingsManager.getInstance();

            // Update the settings based on the payload
            if (command.payload.pattern) {
              console.log(command.payload.pattern);
              await settings.updatePatternSettings(command.payload.pattern);
            }
            if (command.payload.maintenance) {
              await settings.updateMaintenanceSettings(
                command.payload.maintenance
              );
            }
            if (command.payload.speeds) {
              await settings.updateSpeeds(command.payload.speeds);
            }

            // Broadcast the updated settings to all clients
            this.broadcastToAll({
              type: "SETTINGS_UPDATE",
              payload: {
                pattern: settings.getPatternSettings(),
                maintenance: settings.getMaintenanceSettings(),
                speeds: settings.getSpeeds(),
              },
            });

            // If speeds were updated, send them to the ESP32
            if (command.payload.speeds) {
              for (const [side, value] of Object.entries(
                command.payload.speeds
              )) {
                await this.sendSerialCommand(
                  `SPEED ${side.toUpperCase()} ${value}`
                );
              }
            }

            // If pattern settings were updated, send them to the ESP32
            if (command.payload.pattern) {
              const patternConfig = settings.getPatternSettings();
              await this.sendSerialCommand(
                `SET_OFFSET_X ${patternConfig.offsets.x.toFixed(2)}`
              );
              await this.sendSerialCommand(
                `SET_OFFSET_Y ${patternConfig.offsets.y.toFixed(2)}`
              );
              await this.sendSerialCommand(
                `SET_TRAVEL_X ${patternConfig.travelDistance.x.toFixed(2)}`
              );
              await this.sendSerialCommand(
                `SET_TRAVEL_Y ${patternConfig.travelDistance.y.toFixed(2)}`
              );
              await this.sendSerialCommand(
                `SET_GRID ${patternConfig.rows.x} ${patternConfig.rows.y}`
              );
            }
          }
          break;

        default:
          this.sendErrorToClient(ws, "Unknown command");
      }
    } catch (error) {
      console.error(chalk.red("Error handling command:"), error);

      // Send error to the specific client that sent the command
      this.sendErrorToClient(
        ws,
        error instanceof Error ? error.message : "Unknown error occurred"
      );

      // Update system state to ERROR if it's a serious issue
      if (
        error instanceof Error &&
        (error.message.includes("Serial port not connected") ||
          error.message.includes("Failed to send command"))
      ) {
        this.updateStatus({ status: "ERROR" });
      }
    }
  }

  private async sendSerialCommand(command: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.port || !this.port.isOpen) {
        const errorMessage = "Serial port not connected";
        console.error(chalk.red("🔌 Command Error:"), errorMessage);
        this.broadcastToAll({
          type: "WARNING",
          payload: {
            title: "Connection Error",
            message: errorMessage,
            severity: "high",
          },
        });
        reject(new Error(errorMessage));
        return;
      }

      console.log(chalk.green("→ Sending to ESP32:"), chalk.bold(command));
      this.port.write(command + "\n", (err) => {
        if (err) {
          const errorMessage = `Failed to send command: ${err.message}`;
          console.error(chalk.red("🔌 Command Error:"), errorMessage);
          this.broadcastToAll({
            type: "WARNING",
            payload: {
              title: "Command Error",
              message: errorMessage,
              severity: "high",
            },
          });
          reject(new Error(errorMessage));
          return;
        }
        resolve();
      });
    });
  }

  private updateStatus(update: Partial<SystemState>): void {
    this.status = {
      ...this.status,
      ...update,
    };
    this.broadcastStatusUpdate();
  }

  private sendStatusUpdate(ws: WebSocket): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: "STATE_UPDATE",
          payload: this.status,
        })
      );
    }
  }

  private broadcastStatusUpdate(): void {
    this.broadcastToAll({
      type: "STATE_UPDATE",
      payload: this.status,
    });
  }

  private broadcastToAll(message: any): void {
    const messageStr = JSON.stringify(message);
    this.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(messageStr);
      }
    });
  }

  private sendErrorToClient(ws: WebSocket, error: string): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: "ERROR",
          payload: error,
        })
      );
    }
  }

  private startUptimeTimer(): void {
    setInterval(() => {
      const now = new Date();
      const diff = now.getTime() - this.uptimeStart.getTime();

      const days = Math.floor(diff / (1000 * 60 * 60 * 24));
      const hours = Math.floor(
        (diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)
      );
      const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

      this.updateStatus({
        systemInfo: {
          ...this.status.systemInfo,
          uptime: `${days}d ${hours}h ${minutes}m`,
        },
      });
    }, 60000); // Update every minute
  }

  private sendSettingsUpdate(ws: WebSocket): void {
    if (ws.readyState === WebSocket.OPEN) {
      const settings = SettingsManager.getInstance();
      ws.send(
        JSON.stringify({
          type: "SETTINGS_UPDATE",
          payload: {
            pattern: settings.getPatternSettings(),
            maintenance: settings.getMaintenanceSettings(),
            speeds: settings.getSpeeds(),
          },
        })
      );
    }
  }

  async disconnect(): Promise<void> {
    await this.sendSerialCommand("STOP");

    // Close all WebSocket connections
    if (this.wss) {
      this.clients.forEach((client) => client.close());
      this.wss.close();
    }

    // Close serial port
    return new Promise((resolve) => {
      if (this.port && this.port.isOpen) {
        this.port.close(() => {
          console.log(chalk.yellow("🔌 Disconnected from ESP32"));
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}

// Start the server
async function main() {
  try {
    console.log(chalk.blue("🚀 Initializing Paint System Controller..."));

    // Initialize settings first
    const settings = SettingsManager.getInstance();
    await settings.initialize();

    // Get serial configuration automatically
    const serialConfig = await CommandExecutor.getSerialConfig();

    const controller = new PaintSystemController(serialConfig);
    await controller.initialize();

    console.log(chalk.green("✓ Paint System Controller initialized"));

    // Handle graceful shutdown
    process.on("SIGINT", async () => {
      console.log(chalk.yellow("\nShutting down..."));
      await controller.disconnect();
      process.exit(0);
    });
  } catch (error) {
    console.error(chalk.red("Failed to start controller:"), error);
    process.exit(1);
  }
}

main();
