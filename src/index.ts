#!/usr/bin/env node
import { SerialPort } from "serialport";
import { ReadlineParser } from "@serialport/parser-readline";
import { WebSocket, WebSocketServer } from "ws";
import chalk from "chalk";
import { CommandExecutor } from "./CommandExecutor.js";
import { SettingsManager } from "./SettingsManager.js";
import { SystemStatus, WebSocketCommand } from "./types.js";

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
  completed_rows: number[];
  duration: number;
  axis?: "X" | "Y";
}

// Update the SystemState interface
interface SystemState {
  status: SystemStatus;
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
  limitSwitches: {
    x: {
      min: boolean;
      max: boolean;
    };
    y: {
      min: boolean;
      max: boolean;
    };
  };
  servoAngle: number;
}

interface SerialConfig {
  path: string;
  baudRate: number;
}

// Move these to a constants file
const WEBSOCKET_PORT = 8080;
const RECONNECT_MAX_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY = 1000;
const RECONNECT_MAX_DELAY = 30000;

class PaintSystemController {
  private port: SerialPort | null = null;
  private parser: ReadlineParser | null = null;
  private wss: WebSocketServer | null = null;
  private clients: Set<WebSocket> = new Set();
  private uptimeStart: Date = new Date();
  private reconnectAttempts: number = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 5;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private uptimeTimer: NodeJS.Timeout | null = null;

  private status: SystemState = {
    status: SystemStatus.IDLE,
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
    limitSwitches: {
      x: { min: false, max: false },
      y: { min: false, max: false }
    },
    servoAngle: 0,
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

    // Send maintenance settings
    const maintenanceSettings = settings.getMaintenanceSettings();
    await this.sendSerialCommand(`PRIME_TIME ${maintenanceSettings.primeTime}`);
    await this.sendSerialCommand(`CLEAN_TIME ${maintenanceSettings.cleanTime}`);
    await this.sendSerialCommand(
      `BACK_WASH_TIME ${maintenanceSettings.backWashTime}`
    );

    // Send horizontal travel distance
    await this.sendSerialCommand(
      `SET_HORIZONTAL_TRAVEL ${patternConfig.travelDistance.horizontal.x.toFixed(
        2
      )} ${patternConfig.travelDistance.horizontal.y.toFixed(2)}`
    );

    // Send vertical travel distance
    await this.sendSerialCommand(
      `SET_VERTICAL_TRAVEL ${patternConfig.travelDistance.vertical.x.toFixed(
        2
      )} ${patternConfig.travelDistance.vertical.y.toFixed(2)}`
    );

    // Send grid configuration
    await this.sendSerialCommand(
      `SET_GRID ${patternConfig.rows.x} ${patternConfig.rows.y}`
    );

    // Send enabled sides configuration
    const enabledSides = patternConfig.enabledSides;
    await this.sendSerialCommand(
      `SET_ENABLED_SIDES FRONT=${enabledSides.front ? 1 : 0} RIGHT=${enabledSides.right ? 1 : 0} BACK=${enabledSides.back ? 1 : 0} LEFT=${enabledSides.left ? 1 : 0} LIP=${enabledSides.lip ? 1 : 0}`
    );

    // Send initial offsets for each side
    await this.sendSerialCommand(
      `SET_OFFSET FRONT ${patternConfig.initialOffsets.front.x.toFixed(2)} ${
        patternConfig.initialOffsets.front.y.toFixed(2)
      } ${patternConfig.initialOffsets.front.angle.toFixed(2)}`
    );
    await this.sendSerialCommand(
      `SET_OFFSET RIGHT ${patternConfig.initialOffsets.right.x.toFixed(2)} ${
        patternConfig.initialOffsets.right.y.toFixed(2)
      } ${patternConfig.initialOffsets.right.angle.toFixed(2)}`
    );
    await this.sendSerialCommand(
      `SET_OFFSET BACK ${patternConfig.initialOffsets.back.x.toFixed(2)} ${
        patternConfig.initialOffsets.back.y.toFixed(2)
      } ${patternConfig.initialOffsets.back.angle.toFixed(2)}`
    );
    await this.sendSerialCommand(
      `SET_OFFSET LEFT ${patternConfig.initialOffsets.left.x.toFixed(2)} ${
        patternConfig.initialOffsets.left.y.toFixed(2)
      } ${patternConfig.initialOffsets.left.angle.toFixed(2)}`
    );

    // Send lip offset
    await this.sendSerialCommand(
      `SET_OFFSET LIP ${patternConfig.initialOffsets.lip.x.toFixed(2)} ${
        patternConfig.initialOffsets.lip.y.toFixed(2)
      } ${patternConfig.initialOffsets.lip.angle.toFixed(2)}`
    );

    // Send lip travel distance
    await this.sendSerialCommand(
      `SET_LIP_TRAVEL ${patternConfig.travelDistance.lip.x.toFixed(2)} ${
        patternConfig.travelDistance.lip.y.toFixed(2)
      }`
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
    this.wss = new WebSocketServer({ port: WEBSOCKET_PORT });

    this.wss.on("connection", async (ws: WebSocket) => {
      console.log(chalk.green("🔌 New client connected"));
      this.clients.add(ws);

      // Send initial status
      this.sendStatusUpdate(ws);

      // Send initial settings
      this.sendSettingsUpdate(ws);

      // Send available configurations
      try {
        const settings = SettingsManager.getInstance();
        const configs = await settings.listConfigs();
        ws.send(JSON.stringify({
          type: "CONFIGS_UPDATE",
          payload: configs
        }));
      } catch (error) {
        console.error(chalk.red("Error sending configurations:"), error);
        this.sendErrorToClient(ws, "Failed to load configurations");
      }

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
      this.updateStatus({ status: SystemStatus.ERROR });
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

      this.updateStatus({ status: SystemStatus.ERROR });
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
    console.log(
      chalk.yellow("🔌 USB Disconnected:"),
      chalk.gray("Auto-reconnect is temporarily disabled")
    );

    this.broadcastToAll({
      type: "WARNING",
      payload: {
        title: "USB Disconnected",
        message: "USB connection lost. Please check the connection and restart the application.",
        severity: "high",
      },
    });

    // Update system status to ERROR
    this.updateStatus({ status: SystemStatus.ERROR });
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

    // Handle position updates in new format
    const positionMatch = line.match(/Position - X: ([\d.]+) inches, Y: ([\d.]+) inches/);
    if (positionMatch) {
      const x = parseFloat(positionMatch[1]);
      const y = parseFloat(positionMatch[2]);
      
      // Update internal state
      this.updateStatus({ position: { x, y } });
      
      // Broadcast position update as separate event
      this.broadcastToAll({
        type: "POSITION_UPDATE",
        payload: {
          x,
          y,
          timestamp: Date.now()
        }
      });
      
      return;
    }

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
            status: SystemStatus.HOMED,
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
          this.updateStatus({ status: SystemStatus.UNKNOWN });
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
            status: SystemStatus.EXECUTING_PATTERN,
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
            status: status.single_side
              ? SystemStatus.IDLE
              : SystemStatus.HOMED,
            patternProgress: {
              ...this.status.patternProgress,
              command: 0,
              completed_rows: [],
            },
          });
          break;

        case "SPRAY_COMPLETE":
          if (status.row !== undefined) {
            const updatedCompletedRows = [...this.status.patternProgress.completed_rows];
            if (!updatedCompletedRows.includes(status.row - 1)) {
              updatedCompletedRows.push(status.row - 1);
            }
            this.updateStatus({
              patternProgress: {
                ...this.status.patternProgress,
                completed_rows: updatedCompletedRows,
              },
            });
          }
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
            status: SystemStatus.ERROR,
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

    // Handle limit clear messages
    if (line.startsWith('LIMIT_CLEAR:')) {
      const axis = line.split(':')[1].trim();
      const newLimitSwitches = { ...this.status.limitSwitches };
      
      // Reset all limits for the specified axis
      if (axis === 'X') {
        newLimitSwitches.x = { min: false, max: false };
      } else if (axis === 'Y') {
        newLimitSwitches.y = { min: false, max: false };
      }

      // Update state and broadcast
      this.updateStatus({ limitSwitches: newLimitSwitches });
      
      // Log the limit clear event
      console.log(
        chalk.gray("└─"),
        chalk.green("Limit Clear:"),
        chalk.bold(`${axis}-axis limits cleared`)
      );

      return;
    }

    // Handle limit switch messages
    const limitMatch = line.match(/LIMIT:([XY])_(MIN|MAX)/);
    if (limitMatch) {
      const [, axis, direction] = limitMatch;
      const newLimitSwitches = { ...this.status.limitSwitches };
      
      // Only update the specific limit that was triggered
      if (axis === 'X') {
        newLimitSwitches.x[direction.toLowerCase() as 'min' | 'max'] = true;
      } else {
        newLimitSwitches.y[direction.toLowerCase() as 'min' | 'max'] = true;
      }

      // Update state and broadcast
      this.updateStatus({ limitSwitches: newLimitSwitches });
      
      // Log the limit switch event
      console.log(
        chalk.gray("└─"),
        chalk.yellow("Limit Switch:"),
        chalk.bold(`${axis}-axis ${direction.toLowerCase()} limit reached`),
        chalk.bold(JSON.stringify(newLimitSwitches))
      );

      return;
    }

    // Handle servo angle updates
    const servoMatch = line.match(/Servo - Angle: (\d+)/);
    if (servoMatch) {
      const angle = parseInt(servoMatch[1], 10);
      
      // Update internal state
      this.updateStatus({ servoAngle: angle });
      
      // Log the servo angle update
      console.log(
        chalk.gray("└─"),
        chalk.blue("Servo Update:"),
        chalk.bold(`Angle: ${angle}°`)
      );
      
      // Broadcast servo update as separate event
      this.broadcastToAll({
        type: "SERVO_UPDATE",
        payload: {
          angle,
          timestamp: Date.now()
        }
      });
      
      return;
    }
  }

  // Update the handleWebSocketCommand method in PaintSystemController class
  private async handleWebSocketCommand(
    command: WebSocketCommand,
    ws: WebSocket
  ): Promise<void> {
    if (!command || !command.type) {
      this.sendErrorToClient(ws, "Invalid command format");
      return;
    }

    console.log(chalk.blue("📥 Received command:"), command);

    try {
      switch (command.type) {
        case "START_PAINTING":
          const enabledSides = SettingsManager.getInstance().getPatternSettings().enabledSides;
          if (Object.values(enabledSides).some(enabled => enabled)) {
            await this.sendSerialCommand("START");
          } else {
            this.sendErrorToClient(ws, "No sides are enabled for painting");
          }
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
          await this.sendSerialCommand(`PRIME`);
          break;
        case "CLEAN_GUN":
          await this.sendSerialCommand(`CLEAN`);
          break;
        case "BACK_WASH":
          await this.sendSerialCommand("BACK_WASH");
          break;
        case "TOGGLE_PRESSURE_POT":
          await this.sendSerialCommand("PRESSURE");
          break;

        // Single side painting commands
        case "PAINT_FRONT":
          if (SettingsManager.getInstance().getPatternSettings().enabledSides.front) {
            await this.sendSerialCommand("FRONT");
          } else {
            this.sendErrorToClient(ws, "Front side is disabled");
          }
          break;
        case "PAINT_RIGHT":
          if (SettingsManager.getInstance().getPatternSettings().enabledSides.right) {
            await this.sendSerialCommand("RIGHT");
          } else {
            this.sendErrorToClient(ws, "Right side is disabled");
          }
          break;
        case "PAINT_BACK":
          if (SettingsManager.getInstance().getPatternSettings().enabledSides.back) {
            await this.sendSerialCommand("BACK");
          } else {
            this.sendErrorToClient(ws, "Back side is disabled");
          }
          break;
        case "PAINT_LEFT":
          if (SettingsManager.getInstance().getPatternSettings().enabledSides.left) {
            await this.sendSerialCommand("LEFT");
          } else {
            this.sendErrorToClient(ws, "Left side is disabled");
          }
          break;
        case "PAINT_LIP":
          if (SettingsManager.getInstance().getPatternSettings().enabledSides.lip) {
            await this.sendSerialCommand("LIP");
          } else {
            this.sendErrorToClient(ws, "Lip pattern is disabled");
          }
          break;
        case "ROTATE_SPINNER":
          if (!command.payload?.direction || !command.payload?.degrees) {
            this.sendErrorToClient(ws, "Missing direction or degrees for rotation");
            break;
          }
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
              `SET_HORIZONTAL_TRAVEL ${patternConfig.travelDistance.horizontal.x.toFixed(
                2
              )} ${patternConfig.travelDistance.horizontal.y.toFixed(2)}`
            );
            await this.sendSerialCommand(
              `SET_VERTICAL_TRAVEL ${patternConfig.travelDistance.vertical.x.toFixed(
                2
              )} ${patternConfig.travelDistance.vertical.y.toFixed(2)}`
            );
            await this.sendSerialCommand(
              `SET_LIP_TRAVEL ${patternConfig.travelDistance.lip.x.toFixed(
                2
              )} ${patternConfig.travelDistance.lip.y.toFixed(2)}`
            );
            await this.sendSerialCommand(
              `SET_GRID ${patternConfig.rows.x} ${patternConfig.rows.y}`
            );

            // Send enabled sides configuration
            const enabledSides = patternConfig.enabledSides;
            await this.sendSerialCommand(
              `SET_ENABLED_SIDES FRONT=${enabledSides.front ? 1 : 0} RIGHT=${enabledSides.right ? 1 : 0} BACK=${enabledSides.back ? 1 : 0} LEFT=${enabledSides.left ? 1 : 0} LIP=${enabledSides.lip ? 1 : 0}`
            );

            // Update offset commands to include angle
            await this.sendSerialCommand(
              `SET_OFFSET FRONT ${patternConfig.initialOffsets.front.x.toFixed(2)} ${
                patternConfig.initialOffsets.front.y.toFixed(2)
              } ${patternConfig.initialOffsets.front.angle.toFixed(2)}`
            );
            await this.sendSerialCommand(
              `SET_OFFSET RIGHT ${patternConfig.initialOffsets.right.x.toFixed(2)} ${
                patternConfig.initialOffsets.right.y.toFixed(2)
              } ${patternConfig.initialOffsets.right.angle.toFixed(2)}`
            );
            await this.sendSerialCommand(
              `SET_OFFSET BACK ${patternConfig.initialOffsets.back.x.toFixed(2)} ${
                patternConfig.initialOffsets.back.y.toFixed(2)
              } ${patternConfig.initialOffsets.back.angle.toFixed(2)}`
            );
            await this.sendSerialCommand(
              `SET_OFFSET LEFT ${patternConfig.initialOffsets.left.x.toFixed(2)} ${
                patternConfig.initialOffsets.left.y.toFixed(2)
              } ${patternConfig.initialOffsets.left.angle.toFixed(2)}`
            );
            await this.sendSerialCommand(
              `SET_OFFSET LIP ${patternConfig.initialOffsets.lip.x.toFixed(2)} ${
                patternConfig.initialOffsets.lip.y.toFixed(2)
              } ${patternConfig.initialOffsets.lip.angle.toFixed(2)}`
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
              console.log(JSON.stringify(command.payload.pattern));
              await settings.updatePatternSettings(command.payload.pattern);
            }
            if (command.payload.maintenance) {
              await settings.updateMaintenanceSettings(
                command.payload.maintenance
              );

              // Send updated maintenance settings to ESP32
              const maintenanceSettings = settings.getMaintenanceSettings();
              await this.sendSerialCommand(
                `PRIME_TIME ${maintenanceSettings.primeTime}`
              );
              await this.sendSerialCommand(
                `CLEAN_TIME ${maintenanceSettings.cleanTime}`
              );
              await this.sendSerialCommand(
                `BACK_WASH_TIME ${maintenanceSettings.backWashTime}`
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

              // Send horizontal and vertical travel distances
              await this.sendSerialCommand(
                `SET_HORIZONTAL_TRAVEL ${patternConfig.travelDistance.horizontal.x.toFixed(
                  2
                )} ${patternConfig.travelDistance.horizontal.y.toFixed(2)}`
              );
              await this.sendSerialCommand(
                `SET_VERTICAL_TRAVEL ${patternConfig.travelDistance.vertical.x.toFixed(
                  2
                )} ${patternConfig.travelDistance.vertical.y.toFixed(2)}`
              );
              await this.sendSerialCommand(
                `SET_LIP_TRAVEL ${patternConfig.travelDistance.lip.x.toFixed(
                  2
                )} ${patternConfig.travelDistance.lip.y.toFixed(2)}`
              );
              await this.sendSerialCommand(
                `SET_GRID ${patternConfig.rows.x} ${patternConfig.rows.y}`
              );

              // Send enabled sides configuration
              const enabledSides = patternConfig.enabledSides;
              await this.sendSerialCommand(
                `SET_ENABLED_SIDES FRONT=${enabledSides.front ? 1 : 0} RIGHT=${enabledSides.right ? 1 : 0} BACK=${enabledSides.back ? 1 : 0} LEFT=${enabledSides.left ? 1 : 0} LIP=${enabledSides.lip ? 1 : 0}`
              );

              // Update offset commands to include angle
              await this.sendSerialCommand(
                `SET_OFFSET FRONT ${patternConfig.initialOffsets.front.x.toFixed(2)} ${
                  patternConfig.initialOffsets.front.y.toFixed(2)
                } ${patternConfig.initialOffsets.front.angle.toFixed(2)}`
              );
              await this.sendSerialCommand(
                `SET_OFFSET RIGHT ${patternConfig.initialOffsets.right.x.toFixed(2)} ${
                  patternConfig.initialOffsets.right.y.toFixed(2)
                } ${patternConfig.initialOffsets.right.angle.toFixed(2)}`
              );
              await this.sendSerialCommand(
                `SET_OFFSET BACK ${patternConfig.initialOffsets.back.x.toFixed(2)} ${
                  patternConfig.initialOffsets.back.y.toFixed(2)
                } ${patternConfig.initialOffsets.back.angle.toFixed(2)}`
              );
              await this.sendSerialCommand(
                `SET_OFFSET LEFT ${patternConfig.initialOffsets.left.x.toFixed(2)} ${
                  patternConfig.initialOffsets.left.y.toFixed(2)
                } ${patternConfig.initialOffsets.left.angle.toFixed(2)}`
              );
              await this.sendSerialCommand(
                `SET_OFFSET LIP ${patternConfig.initialOffsets.lip.x.toFixed(2)} ${
                  patternConfig.initialOffsets.lip.y.toFixed(2)
                } ${patternConfig.initialOffsets.lip.angle.toFixed(2)}`
              );
            }
          }
          break;

        case "MANUAL_MOVE":
          if (!command.payload?.direction || !command.payload?.state) {
            this.sendErrorToClient(ws, "Missing direction or state for manual move");
            break;
          }

          // Validate direction
          const validDirections = [
            "left", "right", "forward", "backward",
            "forward-left", "forward-right",
            "backward-left", "backward-right"
          ];
          if (!validDirections.includes(command.payload.direction)) {
            this.sendErrorToClient(ws, "Invalid direction for manual move");
            break;
          }

          // Handle movement start/stop
          if (command.payload.state === "START") {
            // Validate speed and acceleration if provided
            const speed = command.payload.speed || 1.0;
            const acceleration = command.payload.acceleration || 1.0;

            // Convert direction to axis and sign
            let axis = "X"; // Default value
            let sign = "+"; // Default value
            switch (command.payload.direction) {
              case "left":
                axis = "X";
                sign = "-";
                break;
              case "right":
                axis = "X";
                sign = "+";
                break;
              case "forward":
                axis = "Y";
                sign = "+";
                break;
              case "backward":
                axis = "Y";
                sign = "-";
                break;
              // Add diagonal movement support
              case "forward-right":
                await this.sendSerialCommand(
                  `MANUAL_MOVE_DIAGONAL X+ Y+ ${speed.toFixed(2)} ${acceleration.toFixed(2)}`
                );
                return;
              case "forward-left":
                await this.sendSerialCommand(
                  `MANUAL_MOVE_DIAGONAL X- Y+ ${speed.toFixed(2)} ${acceleration.toFixed(2)}`
                );
                return;
              case "backward-right":
                await this.sendSerialCommand(
                  `MANUAL_MOVE_DIAGONAL X+ Y- ${speed.toFixed(2)} ${acceleration.toFixed(2)}`
                );
                return;
              case "backward-left":
                await this.sendSerialCommand(
                  `MANUAL_MOVE_DIAGONAL X- Y- ${speed.toFixed(2)} ${acceleration.toFixed(2)}`
                );
                return;
            }

            await this.sendSerialCommand(
              `MANUAL_MOVE ${axis} ${sign} ${speed.toFixed(2)} ${acceleration.toFixed(2)}`
            );
          } else if (command.payload.state === "STOP") {
            await this.sendSerialCommand("MANUAL_STOP");
          } else {
            this.sendErrorToClient(ws, "Invalid state for manual move");
          }
          break;

        case "TOGGLE_SPRAY":
          if (!command.payload?.state) {
            this.sendErrorToClient(ws, "Missing state for spray toggle");
            break;
          }
          
          if (command.payload.state === "START") {
            await this.sendSerialCommand("SPRAY_START");
          } else if (command.payload.state === "STOP") {
            await this.sendSerialCommand("SPRAY_STOP");
          } else {
            this.sendErrorToClient(ws, "Invalid state for spray toggle");
          }
          break;

        case "MOVE_TO_POSITION":
          if (!command.payload?.x || command.payload?.y == undefined) {
            this.sendErrorToClient(ws, "Missing x or y coordinates for position move");
            break;
          } 

          // Validate speed and acceleration
          const moveSpeed = command.payload.speed || 1.0;
          const moveAcceleration = command.payload.acceleration || 1.0;

          // Ensure values are within reasonable ranges
          if (moveSpeed <= 0 || moveSpeed > 1 || moveAcceleration <= 0 || moveAcceleration > 1) {
            this.sendErrorToClient(ws, "Speed and acceleration must be between 0 and 1");
            break;
          }

          try {
            // Send the GOTO command with the specified coordinates
            await this.sendSerialCommand(
              `GOTO ${command.payload.x.toFixed(2)} ${command.payload.y.toFixed(2)}`
            );
          } catch (error) {
            this.sendErrorToClient(
              ws,
              error instanceof Error ? error.message : "Failed to execute movement"
            );
          }
          break;

        case "SET_SERVO_ANGLE":
          if (command.payload?.angle === undefined) {
            this.sendErrorToClient(ws, "Missing angle for servo");
            break;
          }

          // Validate angle is within 0-180 range
          const angle = Number(command.payload.angle);
          if (isNaN(angle) || angle < 0 || angle > 180) {
            this.sendErrorToClient(ws, "Servo angle must be between 0 and 180 degrees");
            break;
          }

          try {
            // Send the SERVO command with the specified angle
            await this.sendSerialCommand(`SERVO ${Math.round(angle)}`);
          } catch (error) {
            this.sendErrorToClient(
              ws,
              error instanceof Error ? error.message : "Failed to set servo angle"
            );
          }
          break;

        case "SAVE_CONFIG":
          if (!command.payload?.name) {
            this.sendErrorToClient(ws, "Missing configuration name");
            break;
          }
          try {
            const settings = SettingsManager.getInstance();
            await settings.saveConfig(
              command.payload.name,
              command.payload.description
            );
            
            // Send updated config list to all clients
            const configs = await settings.listConfigs();
            this.broadcastToAll({
              type: "CONFIGS_UPDATE",
              payload: configs
            });
          } catch (error) {
            this.sendErrorToClient(
              ws,
              error instanceof Error ? error.message : "Failed to save configuration"
            );
          }
          break;

        case "LOAD_CONFIG":
          if (!command.payload?.name) {
            this.sendErrorToClient(ws, "Missing configuration name");
            break;
          }
          try {
            const settings = SettingsManager.getInstance();
            await settings.loadConfig(command.payload.name);
            
            // Get the loaded settings
            const patternConfig = settings.getPatternSettings();
            const maintenanceSettings = settings.getMaintenanceSettings();
            const speeds = settings.getSpeeds();

            // Send all settings to ESP32
            // 1. Send speeds for each side
            for (const [side, value] of Object.entries(speeds)) {
              await this.sendSerialCommand(`SPEED ${side.toUpperCase()} ${value}`);
            }

            // 2. Send maintenance settings
            await this.sendSerialCommand(`PRIME_TIME ${maintenanceSettings.primeTime}`);
            await this.sendSerialCommand(`CLEAN_TIME ${maintenanceSettings.cleanTime}`);
            await this.sendSerialCommand(`BACK_WASH_TIME ${maintenanceSettings.backWashTime}`);

            // 3. Send pattern configuration
            // Send horizontal and vertical travel distances
            await this.sendSerialCommand(
              `SET_HORIZONTAL_TRAVEL ${patternConfig.travelDistance.horizontal.x.toFixed(2)} ${
                patternConfig.travelDistance.horizontal.y.toFixed(2)
              }`
            );
            await this.sendSerialCommand(
              `SET_VERTICAL_TRAVEL ${patternConfig.travelDistance.vertical.x.toFixed(2)} ${
                patternConfig.travelDistance.vertical.y.toFixed(2)
              }`
            );

            // Send lip travel distance
            await this.sendSerialCommand(
              `SET_LIP_TRAVEL ${patternConfig.travelDistance.lip.x.toFixed(2)} ${
                patternConfig.travelDistance.lip.y.toFixed(2)
              }`
            );

            // Send grid configuration
            await this.sendSerialCommand(
              `SET_GRID ${patternConfig.rows.x} ${patternConfig.rows.y}`
            );

            // Send offsets for each side
            await this.sendSerialCommand(
              `SET_OFFSET FRONT ${patternConfig.initialOffsets.front.x.toFixed(2)} ${
                patternConfig.initialOffsets.front.y.toFixed(2)
              } ${patternConfig.initialOffsets.front.angle.toFixed(2)}`
            );
            await this.sendSerialCommand(
              `SET_OFFSET RIGHT ${patternConfig.initialOffsets.right.x.toFixed(2)} ${
                patternConfig.initialOffsets.right.y.toFixed(2)
              } ${patternConfig.initialOffsets.right.angle.toFixed(2)}`
            );
            await this.sendSerialCommand(
              `SET_OFFSET BACK ${patternConfig.initialOffsets.back.x.toFixed(2)} ${
                patternConfig.initialOffsets.back.y.toFixed(2)
              } ${patternConfig.initialOffsets.back.angle.toFixed(2)}`
            );
            await this.sendSerialCommand(
              `SET_OFFSET LEFT ${patternConfig.initialOffsets.left.x.toFixed(2)} ${
                patternConfig.initialOffsets.left.y.toFixed(2)
              } ${patternConfig.initialOffsets.left.angle.toFixed(2)}`
            );
            await this.sendSerialCommand(
              `SET_OFFSET LIP ${patternConfig.initialOffsets.lip.x.toFixed(2)} ${
                patternConfig.initialOffsets.lip.y.toFixed(2)
              } ${patternConfig.initialOffsets.lip.angle.toFixed(2)}`
            );
            
            // Send updated settings to all clients
            this.broadcastToAll({
              type: "SETTINGS_UPDATE",
              payload: {
                pattern: patternConfig,
                maintenance: maintenanceSettings,
                speeds: speeds,
              },
            });

            console.log(chalk.green(`✓ Configuration "${command.payload.name}" applied successfully`));
          } catch (error) {
            this.sendErrorToClient(
              ws,
              error instanceof Error ? error.message : "Failed to load configuration"
            );
          }
          break;

        case "GET_CONFIGS":
          try {
            const settings = SettingsManager.getInstance();
            const configs = await settings.listConfigs();
            ws.send(JSON.stringify({
              type: "CONFIGS_UPDATE",
              payload: configs
            }));
          } catch (error) {
            this.sendErrorToClient(
              ws,
              error instanceof Error ? error.message : "Failed to get configurations"
            );
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
        this.updateStatus({ status: SystemStatus.ERROR });
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
          payload: {
            message: error,
            timestamp: new Date().toISOString(),
          },
        })
      );
    }
  }

  private startUptimeTimer(): void {
    this.uptimeTimer = setInterval(() => {
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
    if (this.uptimeTimer) {
      clearInterval(this.uptimeTimer);
      this.uptimeTimer = null;
    }
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
