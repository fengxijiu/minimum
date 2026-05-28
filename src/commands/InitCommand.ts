import type { Command, CommandContext, CommandResult } from './types.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as readline from 'readline';

// MiMo API 类型定义
type ApiType = 'api' | 'token-plan';
type ModelType = 'mimo-v2.5-pro' | 'mimo-v2.5';
type Region = 'cn' | 'sg' | 'ams';

interface ApiConfig {
  type: ApiType;
  baseUrl: string;
  keyPrefix: string;
  keyFormat: string;
  description: string;
  keyUrl: string;
  regions?: Record<Region, string>;
}

const API_CONFIGS: Record<ApiType, ApiConfig> = {
  'api': {
    type: 'api',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    keyPrefix: 'sk-',
    keyFormat: 'sk-xxxxx',
    description: '按量付费 API - 按实际使用量计费，适合轻度使用',
    keyUrl: 'https://platform.xiaomimimo.com/#/console/api-keys'
  },
  'token-plan': {
    type: 'token-plan',
    baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
    keyPrefix: 'tp-',
    keyFormat: 'tp-xxxxx',
    description: 'Token Plan - 固定订阅费，按套餐限量调用',
    keyUrl: 'https://platform.xiaomimimo.com/#/console/plan-manage',
    regions: {
      'cn': 'https://token-plan-cn.xiaomimimo.com/v1',
      'sg': 'https://token-plan-sgp.xiaomimimo.com/v1',
      'ams': 'https://token-plan-ams.xiaomimimo.com/v1'
    }
  }
};

interface ModelConfig {
  name: string;
  limit: {
    context: number;
    output: number;
  };
  modalities: {
    input: string[];
    output: string[];
  };
  description: string;
}

const MODEL_CONFIGS: Record<ModelType, ModelConfig> = {
  'mimo-v2.5-pro': {
    name: 'mimo-v2.5-pro',
    limit: {
      context: 1048576,
      output: 131072
    },
    modalities: {
      input: ['text'],
      output: ['text']
    },
    description: '专业版 - Agentic 长上下文一致性更强'
  },
  'mimo-v2.5': {
    name: 'mimo-v2.5',
    limit: {
      context: 1048576,
      output: 131072
    },
    modalities: {
      input: ['text', 'image'],
      output: ['text']
    },
    description: '标准版 - 支持图片理解，多模态能力'
  }
};

interface MinimumConfig {
  // OpenAI 兼容配置
  provider: {
    mimo: {
      npm: string;
      name: string;
      options: {
        baseURL: string;
        apiKey: string;
      };
      models: Record<string, ModelConfig>;
    };
  };
  // Minimum 扩展配置
  minimum: {
    apiType: ApiType;
    defaultModel: string;
    tools: {
      enabled: string[];
      permissions: Record<string, string>;
    };
    memory: {
      enabled: boolean;
      path: string;
    };
    skills: {
      enabled: boolean;
      path: string;
    };
    optimization: {
      validation: boolean;
      repair: boolean;
      completeness: boolean;
      context: {
        foldThreshold: number;
        aggressiveThreshold: number;
      };
      iteration: {
        maxRetries: number;
        learnFromErrors: boolean;
      };
    };
    hooks: {
      enabled: boolean;
    };
    approval: {
      mode: string;
      autoApproveLowRisk: boolean;
    };
  };
}

export interface InitOptions {
  apiKey: string;
  apiType?: ApiType;
  model?: ModelType;
  region?: Region;
  baseUrl?: string;
  enableShell?: boolean;
  enableFilesystem?: boolean;
  enableGit?: boolean;
  enableSearch?: boolean;
  enableMemory?: boolean;
  enableSkills?: boolean;
}

export class InitCommand implements Command {
  name = 'init';
  description = 'Initialize MiMo configuration';
  usage = '/init [--quick] [--reset]';

  private rl: readline.Interface | null = null;

  /**
   * Non-interactive init — accepts options directly, no readline needed.
   * Safe to call from Ink TUI (raw mode stdin).
   */
  static async executeFromArgs(workingDirectory: string, options: InitOptions): Promise<CommandResult> {
    const cmd = new InitCommand();

    const apiType = options.apiType ?? (options.apiKey.startsWith('tp-') ? 'token-plan' : 'api');
    const apiConfig = API_CONFIGS[apiType];

    let baseUrl = options.baseUrl;
    if (!baseUrl && apiType === 'token-plan' && options.region && apiConfig.regions) {
      baseUrl = apiConfig.regions[options.region];
    }
    baseUrl = baseUrl ?? apiConfig.baseUrl;

    const model: ModelType = options.model ?? 'mimo-v2.5-pro';
    const config = cmd.buildConfig(options.apiKey, apiType, model, baseUrl, options);

    const configPath = path.join(workingDirectory, 'opencode.json');
    const globalConfigPath = path.join(process.env.HOME || '~', '.config', 'opencode', 'opencode.json');

    await cmd.saveConfig(configPath, config);
    await cmd.saveGlobalConfig(globalConfigPath, config);
    await cmd.createDirectories(workingDirectory);

    // Also export env vars so MiMoClient picks them up immediately
    process.env.MIMO_API_KEY = options.apiKey;
    process.env.MIMO_BASE_URL = baseUrl;

    return {
      success: true,
      output: cmd.formatSuccessMessage(config, configPath, globalConfigPath),
      data: { config },
    };
  }

  async execute(args: string[], context: CommandContext): Promise<CommandResult> {
    const isQuick = args.includes('--quick');
    const isReset = args.includes('--reset');

    // 检查是否已存在配置
    const configPath = path.join(context.workingDirectory, 'opencode.json');
    const globalConfigPath = path.join(process.env.HOME || '~', '.config', 'opencode', 'opencode.json');

    if (!isReset) {
      try {
        await fs.access(configPath);
        return {
          success: false,
          output: `Configuration already exists at ${configPath}\nUse /init --reset to reinitialize`
        };
      } catch {
        // 配置不存在，继续初始化
      }
    }

    // 创建readline接口
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    try {
      let config: MinimumConfig;

      if (isQuick) {
        config = await this.quickSetup();
      } else {
        config = await this.interactiveSetup(context);
      }

      // 保存配置
      await this.saveConfig(configPath, config);
      await this.saveGlobalConfig(globalConfigPath, config);

      // 创建必要的目录
      await this.createDirectories(context.workingDirectory);

      return {
        success: true,
        output: this.formatSuccessMessage(config, configPath, globalConfigPath),
        data: { config }
      };
    } catch (error: any) {
      return {
        success: false,
        output: `Initialization failed: ${error.message}`
      };
    } finally {
      this.rl?.close();
    }
  }

  private async quickSetup(): Promise<MinimumConfig> {
    // 选择API类型
    console.log('\n📡 API Type Selection');
    console.log('  1. 按量付费 API (Pay-as-you-go)');
    console.log('  2. Token Plan (订阅制)');
    const apiTypeChoice = await this.ask('\nSelect API type (1/2, default: 1): ');
    const apiType: ApiType = apiTypeChoice === '2' ? 'token-plan' : 'api';
    const apiConfig = API_CONFIGS[apiType];

    // Token Plan 选择区域
    let baseUrl = apiConfig.baseUrl;
    if (apiType === 'token-plan' && apiConfig.regions) {
      console.log('\n🌏 Region Selection');
      console.log('  1. China (cn)');
      console.log('  2. Singapore (sg)');
      console.log('  3. Europe (ams)');
      const regionChoice = await this.ask('Select region (1/2/3, default: 1): ');
      const region: Region = regionChoice === '2' ? 'sg' : regionChoice === '3' ? 'ams' : 'cn';
      baseUrl = apiConfig.regions[region];
    }

    console.log(`\n  Base URL: ${baseUrl}`);
    console.log(`  API Key format: ${apiConfig.keyFormat}`);
    console.log(`  Get key at: ${apiConfig.keyUrl}\n`);

    const apiKey = await this.ask(`API Key (${apiConfig.keyPrefix}xxxxx): `);

    // 选择模型
    console.log('\n🤖 Model Selection');
    console.log('  1. mimo-v2.5-pro - 专业版，Agentic 长上下文一致性更强');
    console.log('  2. mimo-v2.5     - 标准版，支持图片理解，多模态能力');
    const modelChoice = await this.ask('Select model (1/2, default: 1): ');
    const model: ModelType = modelChoice === '2' ? 'mimo-v2.5' : 'mimo-v2.5-pro';

    return this.createDefaultConfig(apiKey, apiType, model, baseUrl);
  }

  private async interactiveSetup(context: CommandContext): Promise<MinimumConfig> {
    console.log('\n🚀 MiMo Configuration Setup\n');

    // API类型配置
    console.log('📡 API Type Configuration');
    console.log('  1. 按量付费 API (Pay-as-you-go)');
    console.log('     - 按实际使用量计费，适合轻度使用');
    console.log('     - API Key: sk-xxxxx');
    console.log('     - 获取: https://platform.xiaomimimo.com/#/console/api-keys');
    console.log();
    console.log('  2. Token Plan (订阅制)');
    console.log('     - 固定订阅费，按套餐限量调用');
    console.log('     - API Key: tp-xxxxx');
    console.log('     - 获取: https://platform.xiaomimimo.com/#/console/plan-manage');
    console.log();

    const apiTypeChoice = await this.ask('Select API type (1/2, default: 1): ');
    const apiType: ApiType = apiTypeChoice === '2' ? 'token-plan' : 'api';
    const apiConfig = API_CONFIGS[apiType];

    // Token Plan 选择区域
    let baseUrl = apiConfig.baseUrl;
    if (apiType === 'token-plan' && apiConfig.regions) {
      console.log('\n🌏 Region Selection');
      console.log('  1. China (cn) - https://token-plan-cn.xiaomimimo.com/v1');
      console.log('  2. Singapore (sg) - https://token-plan-sgp.xiaomimimo.com/v1');
      console.log('  3. Europe (ams) - https://token-plan-ams.xiaomimimo.com/v1');
      const regionChoice = await this.ask('Select region (1/2/3, default: 1): ');
      const region: Region = regionChoice === '2' ? 'sg' : regionChoice === '3' ? 'ams' : 'cn';
      baseUrl = apiConfig.regions[region];
    }

    const apiKey = await this.ask(`\nAPI Key (${apiConfig.keyFormat}): `);

    // 模型选择
    console.log('\n🤖 Model Selection');
    console.log('  1. mimo-v2.5-pro');
    console.log('     - 专业版，Agentic 长上下文一致性更强');
    console.log('     - 输入: text');
    console.log('     - Context: 1,048,576 tokens');
    console.log();
    console.log('  2. mimo-v2.5');
    console.log('     - 标准版，支持图片理解，多模态能力');
    console.log('     - 输入: text, image');
    console.log('     - Context: 1,048,576 tokens');
    console.log();

    const modelChoice = await this.ask('Select model (1/2, default: 1): ');
    const model: ModelType = modelChoice === '2' ? 'mimo-v2.5' : 'mimo-v2.5-pro';

    // Tools配置
    console.log('\n🔧 Tools Configuration');
    const enableFilesystem = await this.ask('Enable filesystem tools? (Y/n): ');
    const enableShell = await this.ask('Enable shell tools? (y/N): ');
    const enableGit = await this.ask('Enable git tools? (Y/n): ');
    const enableSearch = await this.ask('Enable search tools? (Y/n): ');

    const enabledTools: string[] = [];
    if (enableFilesystem.toLowerCase() !== 'n') enabledTools.push('filesystem');
    if (enableShell.toLowerCase() === 'y') enabledTools.push('shell');
    if (enableGit.toLowerCase() !== 'n') enabledTools.push('git');
    if (enableSearch.toLowerCase() !== 'n') enabledTools.push('search');

    // Memory配置
    console.log('\n💾 Memory Configuration');
    const enableMemory = await this.ask('Enable memory system? (Y/n): ');
    const memoryPath = await this.ask('Memory path (default: ~/.minimum/memory): ') || '~/.minimum/memory';

    // Skills配置
    console.log('\n🎯 Skills Configuration');
    const enableSkills = await this.ask('Enable skills system? (Y/n): ');

    // Optimization配置
    console.log('\n⚡ Optimization Configuration');
    const enableValidation = await this.ask('Enable code validation? (Y/n): ');
    const enableRepair = await this.ask('Enable tool call repair? (Y/n): ');
    const enableCompleteness = await this.ask('Enable completeness check? (Y/n): ');
    const foldThreshold = parseFloat(await this.ask('Context fold threshold (default: 0.70): ') || '0.70');
    const maxRetries = parseInt(await this.ask('Max iteration retries (default: 3): ') || '3');

    // Approval配置
    console.log('\n🔐 Approval Configuration');
    const approvalMode = await this.ask('Approval mode (auto/suggest/never, default: suggest): ') || 'suggest';

    // 构建模型配置
    const models: Record<string, ModelConfig> = {};
    models[model] = MODEL_CONFIGS[model];

    return {
      provider: {
        mimo: {
          npm: '@ai-sdk/openai-compatible',
          name: 'MiMo',
          options: {
            baseURL: baseUrl,
            apiKey
          },
          models
        }
      },
      minimum: {
        apiType,
        defaultModel: model,
        tools: {
          enabled: enabledTools,
          permissions: {
            shell: enableShell.toLowerCase() === 'y' ? 'allow' : 'ask',
            filesystem: 'allow'
          }
        },
        memory: {
          enabled: enableMemory.toLowerCase() !== 'n',
          path: memoryPath
        },
        skills: {
          enabled: enableSkills.toLowerCase() !== 'n',
          path: './skills'
        },
        optimization: {
          validation: enableValidation.toLowerCase() !== 'n',
          repair: enableRepair.toLowerCase() !== 'n',
          completeness: enableCompleteness.toLowerCase() !== 'n',
          context: {
            foldThreshold,
            aggressiveThreshold: 0.75
          },
          iteration: {
            maxRetries,
            learnFromErrors: true
          }
        },
        hooks: {
          enabled: true
        },
        approval: {
          mode: approvalMode,
          autoApproveLowRisk: true
        }
      }
    };
  }

  private buildConfig(apiKey: string, apiType: ApiType, model: ModelType, baseUrl: string, opts: InitOptions): MinimumConfig {
    const models: Record<string, ModelConfig> = {};
    models[model] = MODEL_CONFIGS[model];

    const enabledTools: string[] = [];
    if (opts.enableFilesystem !== false) enabledTools.push('filesystem');
    if (opts.enableShell) enabledTools.push('shell');
    if (opts.enableGit !== false) enabledTools.push('git');
    if (opts.enableSearch !== false) enabledTools.push('search');

    return {
      provider: {
        mimo: {
          npm: '@ai-sdk/openai-compatible',
          name: 'MiMo',
          options: { baseURL: baseUrl, apiKey },
          models,
        },
      },
      minimum: {
        apiType,
        defaultModel: model,
        tools: {
          enabled: enabledTools,
          permissions: {
            shell: opts.enableShell ? 'allow' : 'ask',
            filesystem: 'allow',
          },
        },
        memory: { enabled: opts.enableMemory !== false, path: '~/.minimum/memory' },
        skills: { enabled: opts.enableSkills !== false, path: './skills' },
        optimization: {
          validation: true,
          repair: true,
          completeness: true,
          context: { foldThreshold: 0.70, aggressiveThreshold: 0.75 },
          iteration: { maxRetries: 3, learnFromErrors: true },
        },
        hooks: { enabled: true },
        approval: { mode: 'suggest', autoApproveLowRisk: true },
      },
    };
  }

  private createDefaultConfig(apiKey: string, apiType: ApiType, model: ModelType, baseUrl?: string): MinimumConfig {
    const apiConfig = API_CONFIGS[apiType];
    const models: Record<string, ModelConfig> = {};
    models[model] = MODEL_CONFIGS[model];

    return {
      provider: {
        mimo: {
          npm: '@ai-sdk/openai-compatible',
          name: 'MiMo',
          options: {
            baseURL: baseUrl || apiConfig.baseUrl,
            apiKey
          },
          models
        }
      },
      minimum: {
        apiType,
        defaultModel: model,
        tools: {
          enabled: ['filesystem', 'git', 'search'],
          permissions: {
            shell: 'ask',
            filesystem: 'allow'
          }
        },
        memory: {
          enabled: true,
          path: '~/.minimum/memory'
        },
        skills: {
          enabled: true,
          path: './skills'
        },
        optimization: {
          validation: true,
          repair: true,
          completeness: true,
          context: {
            foldThreshold: 0.70,
            aggressiveThreshold: 0.75
          },
          iteration: {
            maxRetries: 3,
            learnFromErrors: true
          }
        },
        hooks: {
          enabled: true
        },
        approval: {
          mode: 'suggest',
          autoApproveLowRisk: true
        }
      }
    };
  }

  private async saveConfig(configPath: string, config: MinimumConfig): Promise<void> {
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  }

  private async saveGlobalConfig(globalConfigPath: string, config: MinimumConfig): Promise<void> {
    await fs.mkdir(path.dirname(globalConfigPath), { recursive: true });
    
    // 保存全局配置（使用环境变量引用）
    const globalConfig = {
      ...config,
      provider: {
        mimo: {
          ...config.provider.mimo,
          options: {
            baseURL: '${MIMO_BASE_URL}',
            apiKey: '${MIMO_API_KEY}'
          }
        }
      }
    };
    
    await fs.writeFile(globalConfigPath, JSON.stringify(globalConfig, null, 2));
  }

  private async createDirectories(projectRoot: string): Promise<void> {
    const dirs = [
      path.join(projectRoot, '.minimum'),
      path.join(projectRoot, '.minimum', 'memory'),
      path.join(projectRoot, '.minimum', 'sessions'),
      path.join(projectRoot, '.minimum', 'checkpoints'),
      path.join(projectRoot, '.minimum', 'skills'),
      path.join(projectRoot, '.minimum', 'transcripts'),
      path.join(process.env.HOME || '~', '.minimum'),
      path.join(process.env.HOME || '~', '.minimum', 'memory'),
      path.join(process.env.HOME || '~', '.minimum', 'sessions'),
      path.join(process.env.HOME || '~', '.minimum', 'skills')
    ];

    for (const dir of dirs) {
      await fs.mkdir(dir, { recursive: true });
    }
  }

  private formatSuccessMessage(config: MinimumConfig, configPath: string, globalConfigPath: string): string {
    const apiConfig = API_CONFIGS[config.minimum.apiType];
    const modelConfig = MODEL_CONFIGS[config.minimum.defaultModel as ModelType];
    
    return `
╔═══════════════════════════════════════════════════════════════╗
║                    ✅ Configuration Complete                   ║
╚═══════════════════════════════════════════════════════════════╝

📡 API Configuration:
   • Type: ${apiConfig.description}
   • Base URL: ${config.provider.mimo.options.baseURL}

🤖 Model Configuration:
   • Model: ${config.minimum.defaultModel}
   • Description: ${modelConfig.description}
   • Context: ${modelConfig.limit.context.toLocaleString()} tokens
   • Output: ${modelConfig.limit.output.toLocaleString()} tokens
   • Input Modalities: ${modelConfig.modalities.input.join(', ')}

📁 Configuration files created:
   • Project: ${configPath}
   • Global:  ${globalConfigPath}

📂 Directories created:
   • .minimum/
   • .minimum/memory/
   • .minimum/sessions/
   • .minimum/checkpoints/
   • .minimum/skills/
   • .minimum/transcripts/

🚀 Quick Start:
   1. Start coding: minimum
   2. Type your task and press Enter

📖 Commands:
   /help     - Show help
   /status   - Show status
   /config   - View configuration
   /new      - Start new session

Happy coding! 🎉
`;
  }

  private ask(question: string): Promise<string> {
    return new Promise((resolve) => {
      this.rl!.question(question, (answer) => {
        resolve(answer.trim());
      });
    });
  }
}
