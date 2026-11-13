/**
 * Runtime form v2 copy by request language (packages/runtime-form README,
 * "Protocol v2"). The form structure is the same in every language; only the
 * display strings in `uiSchema.localization` and the generic option labels of an
 * option source change.
 *
 * A client asks with `Accept-Language` (BCP 47) on the v2 form, edit form and
 * option-source requests; a client that sends none gets English, exactly as
 * before. Translations are keyed by the English string, so copy that has no
 * translation yet stays English instead of disappearing. Wording follows the web
 * app's messages for the same locale (packages/web/src/i18n/messages/).
 */
import type { Response } from "express";
import type { RuntimeFormV2Definition, RuntimeFormV2Option } from "@botiverse/raft-runtime-form";
import { displayLocaleTag, matchDisplayLocale } from "@botiverse/raft-shared";
import type { DisplayLocale } from "@botiverse/raft-shared";

/** Copy follows the display-locale registry: one table per non-English locale. */
export type RuntimeFormCopyLocale = DisplayLocale;

const ZH_CN: Readonly<Record<string, string>> = Object.freeze({
  "Models from this computer's Qwen Code settings. You can also type a model ID. Qwen Code has no login: set its provider with OPENAI_API_KEY, OPENAI_BASE_URL and OPENAI_MODEL under Environment Variables.":
    "这台电脑上 Qwen Code 设置里的模型。也可以直接填写模型 ID。Qwen Code 没有登录：在环境变量里用 OPENAI_API_KEY、OPENAI_BASE_URL 和 OPENAI_MODEL 设置它的模型服务。",
  "Models available to this computer's Qoder login (qodercli login). You can also type a model ID.":
    "这台电脑上 Qoder 登录（qodercli login）可用的模型。也可以直接填写模型 ID。",
  "Models available to this computer's CodeBuddy Code login. You can also type a model ID.":
    "这台电脑上 CodeBuddy Code 登录可用的模型。也可以直接填写模型 ID。",
  "Models available to this computer's Antigravity login. AGY configured default lets Antigravity choose. You can also type a model ID.":
    "这台电脑上 Antigravity 登录可用的模型。选择 AGY configured default 则由 Antigravity 自行决定。也可以直接填写模型 ID。",
  // Field labels
  "API Key": "API 密钥",
  "Authentication": "身份验证",
  "API URL": "API URL",
  "Base URL": "Base URL",
  "Claude Command": "Claude 命令",
  "Effort": "推理强度",
  "Environment Variables": "环境变量",
  "Fast mode": "快速模式",
  "Fast tier": "快速档",
  "Load local Pi extensions": "加载本机 Pi 扩展",
  "Model": "模型",
  "Model ID": "模型 ID",
  "Provider": "提供方",
  "Reasoning": "推理强度",
  "Supports image input": "支持图片输入",
  "Thinking effort": "思考强度",
  "Tier": "档位",
  // Field hints
  "Available values are declared by the selected model.": "可选值由所选模型决定。",
  "Available values depend on the selected model.": "可选值取决于所选模型。",
  "Built-in Pi is ready to use without local runtime setup. It uses the provider key entered here.":
    "内置 Pi 无需本地运行时设置即可使用。它会使用这里填写的提供方密钥。",
  "Configured uses your machine's Pi auth.json. Other options inject the matching API key as an env var so the Pi SDK picks it up — no auth.json edit on your machine.":
    "已配置模式会使用你机器上的 Pi auth.json。其他选项会把对应 API 密钥注入为环境变量，让 Pi SDK 自动读取——无需修改机器上的 auth.json。",
  "Default leaves Claude Code provider settings untouched. Custom sets ANTHROPIC_BASE_URL and, from the key, ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN for this agent.":
    "默认模式不改动 Claude Code 提供方设置。自定义模式会为此 Agent 设置 ANTHROPIC_BASE_URL，并按所选方式把密钥设为 ANTHROPIC_API_KEY 或 ANTHROPIC_AUTH_TOKEN。",
  "Use Bearer token for a gateway that expects an Authorization header.": "网关要求 Authorization 请求头时，选择 Bearer token。",
  "Context window (tokens)": "上下文窗口（token）",
  "Optional. Overrides the model's context window. Leave empty to use the listed model's own value or Raft's default. A gateway can provide both limits automatically. [Learn more](https://docs.raft.build/developers/gateway-model-limits/)":
    "可选。覆盖这个模型的上下文窗口。留空则用列表里这个模型自带的值，或 Raft 的默认值。网关可以自动提供这两个上限。[了解更多](https://docs.raft.build/zh-cn/developers/gateway-model-limits/)",
  "Max output tokens": "单次最大输出 token",
  "Optional. Overrides the most tokens the model may write in one reply. Leave empty to use the listed model's own value or Raft's default. A gateway can provide both limits automatically. [Learn more](https://docs.raft.build/developers/gateway-model-limits/)":
    "可选。覆盖模型一次回复最多能写的 token 数。留空则用列表里这个模型自带的值，或 Raft 的默认值。网关可以自动提供这两个上限。[了解更多](https://docs.raft.build/zh-cn/developers/gateway-model-limits/)",
  "Enable only when this gateway endpoint and model accept images.": "仅当此 gateway endpoint 和模型接受图片时开启。",
  "Executable path or command name; Slock adds the Claude stream-json runtime arguments.":
    "可执行文件路径或命令名；Slock 会追加 Claude stream-json 运行时参数。",
  "Launch this runtime with higher speed at a higher cost per token.": "以更高的单 token 成本换取更快的速度启动此运行时。",
  "Load enabled Pi extensions installed on the computer running this agent. Applying changes restarts a running agent.":
    "加载运行此 Agent 的电脑上已安装并启用的 Pi 扩展。应用更改会重启正在运行的 Agent。",
  "Models Claude Code accepts. You can also type a model ID.": "Claude Code 支持的模型。也可以直接填写模型 ID。",
  "Models GitHub Copilot CLI accepts. You can also type a model ID.": "GitHub Copilot CLI 支持的模型。也可以直接填写模型 ID。",
  "Models available from this computer's Codex CLI. You can also type a model ID.":
    "这台电脑上 Codex CLI 可用的模型。也可以直接填写模型 ID。",
  "Models available from this computer's Cursor CLI. You can also type a model ID.":
    "这台电脑上 Cursor CLI 可用的模型。也可以直接填写模型 ID。",
  "Models available from this computer's Grok CLI.": "这台电脑上 Grok CLI 可用的模型。",
  "Models available from this computer's Kimi CLI configuration.": "这台电脑上 Kimi CLI 配置中可用的模型。",
  "Models available from this computer's Kimi configuration.": "这台电脑上 Kimi 配置中可用的模型。",
  "Models available from this computer's OpenCode configuration.": "这台电脑上 OpenCode 配置中可用的模型。",
  "Models available from this computer's Pi configuration. You can also type a model ID.":
    "这台电脑上 Pi 配置中可用的模型。也可以直接填写模型 ID。",
  "Models the selected provider offers.": "所选提供方提供的模型。",
  "These will be injected into the runtime command environment.": "这些变量会注入到运行时命令的环境中。",
  "Use a model ID the selected provider supports.": "请填写所选提供方支持的模型 ID。",
  // Choice descriptions. Effort level names stay English, as in the web app.
  // Translated, unlike the other level names: it says what the level does.
  "No reasoning": "不推理",
  "Answers directly, without a thinking phase": "直接回答，不进行思考",
  "Very light reasoning for the fastest responses": "极少量推理，响应最快",
  "Fast responses with lighter reasoning": "快速响应，推理较轻",
  "Balances speed and reasoning depth for everyday tasks": "在日常任务中平衡速度与推理深度",
  "Greater reasoning depth for complex problems": "针对复杂问题提供更深入的推理",
  "Extra high reasoning depth for complex problems": "针对复杂问题提供极高推理深度",
  "Maximum reasoning depth for the hardest problems": "针对最难的问题提供最大推理深度",
  "Maximum reasoning with automatic task delegation": "最大推理，并自动进行任务委派",
  "Lower latency": "更低延迟",
  // Generic option labels (model and provider names are never translated)
  "Auto": "自动",
  "Configured": "已配置",
  "Configured Default": "已配置的默认值",
  "Configured Default / Auto": "已配置的默认值 / 自动",
  "API key (x-api-key)": "API 密钥（x-api-key）",
  "Bearer token (Authorization)": "Bearer token（Authorization）",
  "Custom": "自定义",
  "Default": "默认",
  // v3 unavailableOptions reasons for a saved connection
  "This saved provider is disabled.": "此已保存提供方已停用。",
  "This saved provider has no credential.": "此已保存提供方缺少凭据。",
});

const JA: Readonly<Record<string, string>> = Object.freeze({
  "Models from this computer's Qwen Code settings. You can also type a model ID. Qwen Code has no login: set its provider with OPENAI_API_KEY, OPENAI_BASE_URL and OPENAI_MODEL under Environment Variables.":
    "このコンピューターの Qwen Code 設定にあるモデルです。モデル ID を直接入力することもできます。Qwen Code にはログインがありません。環境変数の OPENAI_API_KEY、OPENAI_BASE_URL、OPENAI_MODEL でプロバイダーを設定してください。",
  "Models available to this computer's Qoder login (qodercli login). You can also type a model ID.":
    "このコンピューターの Qoder ログイン（qodercli login）で使えるモデルです。モデル ID を直接入力することもできます。",
  "Models available to this computer's CodeBuddy Code login. You can also type a model ID.":
    "このコンピューターの CodeBuddy Code ログインで使えるモデルです。モデル ID を直接入力することもできます。",
  "Models available to this computer's Antigravity login. AGY configured default lets Antigravity choose. You can also type a model ID.":
    "このコンピューターの Antigravity ログインで使えるモデルです。AGY configured default を選ぶと Antigravity が選びます。モデル ID を直接入力することもできます。",
  // Field labels
  "API Key": "API キー",
  "Authentication": "認証",
  "API URL": "API URL",
  "Base URL": "ベース URL",
  "Claude Command": "Claude コマンド",
  "Effort": "推論の強度",
  "Environment Variables": "環境変数",
  "Fast mode": "高速モード",
  "Fast tier": "高速ティア",
  "Load local Pi extensions": "ローカルの Pi 拡張機能を読み込む",
  "Model": "モデル",
  "Model ID": "モデル ID",
  "Provider": "プロバイダー",
  "Reasoning": "推論の強度",
  "Supports image input": "画像入力に対応",
  "Thinking effort": "思考の強度",
  "Tier": "ティア",
  // Field hints
  "Available values are declared by the selected model.": "選択できる値は、選択したモデルによって決まります。",
  "Available values depend on the selected model.": "選択できる値は、選択したモデルによって異なります。",
  "Built-in Pi is ready to use without local runtime setup. It uses the provider key entered here.":
    "組み込みの Pi は、ローカルのランタイムを設定しなくてもすぐに使えます。ここで入力したプロバイダーのキーを使用します。",
  "Configured uses your machine's Pi auth.json. Other options inject the matching API key as an env var so the Pi SDK picks it up — no auth.json edit on your machine.":
    "「設定済み」はお使いのマシンの Pi auth.json を使用します。その他のオプションでは、対応する API キーを環境変数として注入し、Pi SDK に読み込ませます。マシン上の auth.json を編集する必要はありません。",
  "Default leaves Claude Code provider settings untouched. Custom sets ANTHROPIC_BASE_URL and, from the key, ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN for this agent.":
    "「デフォルト」は Claude Code のプロバイダー設定を変更しません。「カスタム」はこのエージェントに ANTHROPIC_BASE_URL を設定し、キーを ANTHROPIC_API_KEY または ANTHROPIC_AUTH_TOKEN として設定します。",
  "Use Bearer token for a gateway that expects an Authorization header.": "Authorization ヘッダーを求めるゲートウェイでは Bearer token を選んでください。",
  "Context window (tokens)": "コンテキストウィンドウ（トークン）",
  "Optional. Overrides the model's context window. Leave empty to use the listed model's own value or Raft's default. A gateway can provide both limits automatically. [Learn more](https://docs.raft.build/developers/gateway-model-limits/)":
    "任意。このモデルのコンテキストウィンドウを上書きします。空欄なら一覧にあるモデル自身の値、または Raft の既定値を使います。ゲートウェイは両方の上限を自動で提供できます。[詳細を見る](https://docs.raft.build/developers/gateway-model-limits/)",
  "Max output tokens": "最大出力トークン",
  "Optional. Overrides the most tokens the model may write in one reply. Leave empty to use the listed model's own value or Raft's default. A gateway can provide both limits automatically. [Learn more](https://docs.raft.build/developers/gateway-model-limits/)":
    "任意。モデルが 1 回の返答で書けるトークンの上限を上書きします。空欄なら一覧にあるモデル自身の値、または Raft の既定値を使います。ゲートウェイは両方の上限を自動で提供できます。[詳細を見る](https://docs.raft.build/developers/gateway-model-limits/)",
  "Enable only when this gateway endpoint and model accept images.": "このゲートウェイのエンドポイントとモデルが画像に対応している場合のみ有効にしてください。",
  "Executable path or command name; Slock adds the Claude stream-json runtime arguments.":
    "実行ファイルのパスまたはコマンド名。Claude stream-json のランタイム引数は Slock が追加します。",
  "Launch this runtime with higher speed at a higher cost per token.": "このランタイムを高速モードで起動します。トークンあたりのコストは高くなります。",
  "Load enabled Pi extensions installed on the computer running this agent. Applying changes restarts a running agent.":
    "このエージェントを実行しているコンピューターにインストールされ、有効になっている Pi 拡張機能を読み込みます。変更を適用すると、実行中のエージェントは再起動されます。",
  "Models Claude Code accepts. You can also type a model ID.": "Claude Code で使えるモデルです。モデル ID を直接入力することもできます。",
  "Models GitHub Copilot CLI accepts. You can also type a model ID.": "GitHub Copilot CLI で使えるモデルです。モデル ID を直接入力することもできます。",
  "Models available from this computer's Codex CLI. You can also type a model ID.":
    "このコンピューターの Codex CLI で使えるモデルです。モデル ID を直接入力することもできます。",
  "Models available from this computer's Cursor CLI. You can also type a model ID.":
    "このコンピューターの Cursor CLI で使えるモデルです。モデル ID を直接入力することもできます。",
  "Models available from this computer's Grok CLI.": "このコンピューターの Grok CLI で使えるモデルです。",
  "Models available from this computer's Kimi CLI configuration.": "このコンピューターの Kimi CLI の設定で使えるモデルです。",
  "Models available from this computer's Kimi configuration.": "このコンピューターの Kimi の設定で使えるモデルです。",
  "Models available from this computer's OpenCode configuration.": "このコンピューターの OpenCode の設定で使えるモデルです。",
  "Models available from this computer's Pi configuration. You can also type a model ID.":
    "このコンピューターの Pi の設定で使えるモデルです。モデル ID を直接入力することもできます。",
  "Models the selected provider offers.": "選択したプロバイダーが提供するモデルです。",
  "These will be injected into the runtime command environment.": "ランタイムのコマンド環境に注入されます。",
  "Use a model ID the selected provider supports.": "選択したプロバイダーが対応しているモデル ID を入力してください。",
  // Choice descriptions. Effort level names stay English, as in the web app.
  "No reasoning": "推論なし",
  "Answers directly, without a thinking phase": "思考せずに直接回答",
  "Very light reasoning for the fastest responses": "ごく軽い推論で最速に応答",
  "Fast responses with lighter reasoning": "軽めの推論で高速に応答",
  "Balances speed and reasoning depth for everyday tasks": "日常的なタスク向けに速度と推論の深さを両立",
  "Greater reasoning depth for complex problems": "複雑な問題に向けてより深く推論",
  "Extra high reasoning depth for complex problems": "複雑な問題に向けて非常に深く推論",
  "Maximum reasoning depth for the hardest problems": "最も難しい問題に向けて最大限の深さで推論",
  "Maximum reasoning with automatic task delegation": "最大限の推論とタスクの自動委任",
  "Lower latency": "低レイテンシー",
  // Generic option labels (model and provider names are never translated)
  "Auto": "自動",
  "Configured": "設定済み",
  "Configured Default": "設定済みのデフォルト",
  "Configured Default / Auto": "設定済みのデフォルト / 自動",
  "API key (x-api-key)": "API キー（x-api-key）",
  "Bearer token (Authorization)": "Bearer token（Authorization）",
  "Custom": "カスタム",
  "Default": "デフォルト",
  // v3 unavailableOptions reasons for a saved connection
  "This saved provider is disabled.": "この保存済みプロバイダーは無効になっています。",
  "This saved provider has no credential.": "この保存済みプロバイダーには認証情報がありません。",
});

const ES: Readonly<Record<string, string>> = Object.freeze({
  "Models from this computer's Qwen Code settings. You can also type a model ID. Qwen Code has no login: set its provider with OPENAI_API_KEY, OPENAI_BASE_URL and OPENAI_MODEL under Environment Variables.":
    "Modelos de la configuración de Qwen Code en este equipo. También puedes escribir un ID de modelo. Qwen Code no tiene inicio de sesión: configura su proveedor con OPENAI_API_KEY, OPENAI_BASE_URL y OPENAI_MODEL en Variables de entorno.",
  "Models available to this computer's Qoder login (qodercli login). You can also type a model ID.":
    "Modelos disponibles para el inicio de sesión de Qoder en este equipo (qodercli login). También puedes escribir un ID de modelo.",
  "Models available to this computer's CodeBuddy Code login. You can also type a model ID.":
    "Modelos disponibles para el inicio de sesión de CodeBuddy Code en este equipo. También puedes escribir un ID de modelo.",
  "Models available to this computer's Antigravity login. AGY configured default lets Antigravity choose. You can also type a model ID.":
    "Modelos disponibles para el inicio de sesión de Antigravity en este equipo. AGY configured default deja que Antigravity elija. También puedes escribir un ID de modelo.",
  // Field labels
  "API Key": "Clave de API",
  "Authentication": "Autenticación",
  "API URL": "URL de la API",
  "Base URL": "URL base",
  "Claude Command": "Comando de Claude",
  "Effort": "Esfuerzo de razonamiento",
  "Environment Variables": "Variables de entorno",
  "Fast mode": "Modo rápido",
  "Fast tier": "Nivel rápido",
  "Load local Pi extensions": "Cargar extensiones locales de Pi",
  "Model": "Modelo",
  "Model ID": "ID del modelo",
  "Provider": "Proveedor",
  "Reasoning": "Razonamiento",
  "Supports image input": "Admite entrada de imágenes",
  "Thinking effort": "Esfuerzo de pensamiento",
  "Tier": "Nivel",
  // Field hints
  "Available values are declared by the selected model.": "Los valores disponibles los define el modelo seleccionado.",
  "Available values depend on the selected model.": "Los valores disponibles dependen del modelo seleccionado.",
  "Built-in Pi is ready to use without local runtime setup. It uses the provider key entered here.":
    "Built-in Pi está listo para usarse sin configurar un runtime local. Usa la clave del proveedor que ingreses aquí.",
  "Configured uses your machine's Pi auth.json. Other options inject the matching API key as an env var so the Pi SDK picks it up — no auth.json edit on your machine.":
    "“Configurado” usa el auth.json de Pi de tu computadora. Las demás opciones inyectan la clave de API correspondiente como variable de entorno para que el SDK de Pi la detecte, sin editar el auth.json de tu computadora.",
  "Default leaves Claude Code provider settings untouched. Custom sets ANTHROPIC_BASE_URL and, from the key, ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN for this agent.":
    "“Predeterminado” no modifica la configuración del proveedor de Claude Code. “Personalizado” define ANTHROPIC_BASE_URL y, con la clave, ANTHROPIC_API_KEY o ANTHROPIC_AUTH_TOKEN para este agente.",
  "Use Bearer token for a gateway that expects an Authorization header.": "Usa Bearer token con un gateway que espera un encabezado Authorization.",
  "Context window (tokens)": "Ventana de contexto (tokens)",
  "Optional. Overrides the model's context window. Leave empty to use the listed model's own value or Raft's default. A gateway can provide both limits automatically. [Learn more](https://docs.raft.build/developers/gateway-model-limits/)":
    "Opcional. Sustituye la ventana de contexto del modelo. Déjalo vacío para usar el valor del propio modelo de la lista o el predeterminado de Raft. Un gateway puede proporcionar ambos límites automáticamente. [Más información](https://docs.raft.build/developers/gateway-model-limits/)",
  "Max output tokens": "Máximo de tokens de salida",
  "Optional. Overrides the most tokens the model may write in one reply. Leave empty to use the listed model's own value or Raft's default. A gateway can provide both limits automatically. [Learn more](https://docs.raft.build/developers/gateway-model-limits/)":
    "Opcional. Sustituye lo máximo que el modelo puede escribir en una respuesta. Déjalo vacío para usar el valor del propio modelo de la lista o el predeterminado de Raft. Un gateway puede proporcionar ambos límites automáticamente. [Más información](https://docs.raft.build/developers/gateway-model-limits/)",
  "Enable only when this gateway endpoint and model accept images.":
    "Actívalo solo si este endpoint del gateway y el modelo aceptan imágenes.",
  "Executable path or command name; Slock adds the Claude stream-json runtime arguments.":
    "Ruta del ejecutable o nombre del comando; Slock agrega los argumentos de runtime stream-json de Claude.",
  "Launch this runtime with higher speed at a higher cost per token.":
    "Inicia este runtime con mayor velocidad, a un costo por token más alto.",
  "Load enabled Pi extensions installed on the computer running this agent. Applying changes restarts a running agent.":
    "Carga las extensiones de Pi habilitadas que estén instaladas en la computadora que ejecuta este agente. Al aplicar los cambios, se reinicia el agente si está en ejecución.",
  "Models Claude Code accepts. You can also type a model ID.":
    "Modelos que acepta Claude Code. También puedes escribir un ID de modelo.",
  "Models GitHub Copilot CLI accepts. You can also type a model ID.":
    "Modelos que acepta GitHub Copilot CLI. También puedes escribir un ID de modelo.",
  "Models available from this computer's Codex CLI. You can also type a model ID.":
    "Modelos disponibles en Codex CLI de esta computadora. También puedes escribir un ID de modelo.",
  "Models available from this computer's Cursor CLI. You can also type a model ID.":
    "Modelos disponibles en Cursor CLI de esta computadora. También puedes escribir un ID de modelo.",
  "Models available from this computer's Grok CLI.": "Modelos disponibles en Grok CLI de esta computadora.",
  "Models available from this computer's Kimi CLI configuration.":
    "Modelos disponibles en la configuración de Kimi CLI de esta computadora.",
  "Models available from this computer's Kimi configuration.":
    "Modelos disponibles en la configuración de Kimi de esta computadora.",
  "Models available from this computer's OpenCode configuration.":
    "Modelos disponibles en la configuración de OpenCode de esta computadora.",
  "Models available from this computer's Pi configuration. You can also type a model ID.":
    "Modelos disponibles en la configuración de Pi de esta computadora. También puedes escribir un ID de modelo.",
  "Models the selected provider offers.": "Modelos que ofrece el proveedor seleccionado.",
  "These will be injected into the runtime command environment.":
    "Se inyectarán en el entorno del comando del runtime.",
  "Use a model ID the selected provider supports.": "Usa un ID de modelo que admita el proveedor seleccionado.",
  // Choice descriptions. Effort level names stay English, as in the web app.
  "No reasoning": "Sin razonamiento",
  "Answers directly, without a thinking phase": "Responde directamente, sin una fase de razonamiento",
  "Very light reasoning for the fastest responses": "Razonamiento muy ligero para las respuestas más rápidas",
  "Fast responses with lighter reasoning": "Respuestas rápidas con un razonamiento más ligero",
  "Balances speed and reasoning depth for everyday tasks":
    "Equilibra velocidad y profundidad de razonamiento para las tareas diarias",
  "Greater reasoning depth for complex problems": "Mayor profundidad de razonamiento para problemas complejos",
  "Extra high reasoning depth for complex problems": "Profundidad de razonamiento muy alta para problemas complejos",
  "Maximum reasoning depth for the hardest problems":
    "Máxima profundidad de razonamiento para los problemas más difíciles",
  "Maximum reasoning with automatic task delegation": "Razonamiento máximo con delegación automática de tareas",
  "Lower latency": "Menor latencia",
  // Generic option labels (model and provider names are never translated)
  "Auto": "Automático",
  "Configured": "Configurado",
  "Configured Default": "Predeterminado configurado",
  "Configured Default / Auto": "Predeterminado configurado / Automático",
  "API key (x-api-key)": "Clave de API (x-api-key)",
  "Bearer token (Authorization)": "Bearer token (Authorization)",
  "Custom": "Personalizado",
  "Default": "Predeterminado",
  // v3 unavailableOptions reasons for a saved connection
  "This saved provider is disabled.": "Este proveedor guardado está desactivado.",
  "This saved provider has no credential.": "Este proveedor guardado no tiene credencial.",
});

const PT_BR: Readonly<Record<string, string>> = Object.freeze({
  "Models from this computer's Qwen Code settings. You can also type a model ID. Qwen Code has no login: set its provider with OPENAI_API_KEY, OPENAI_BASE_URL and OPENAI_MODEL under Environment Variables.":
    "Modelos das configurações do Qwen Code neste computador. Você também pode digitar um ID de modelo. O Qwen Code não tem login: configure o provedor com OPENAI_API_KEY, OPENAI_BASE_URL e OPENAI_MODEL em Variáveis de ambiente.",
  "Models available to this computer's Qoder login (qodercli login). You can also type a model ID.":
    "Modelos disponíveis para o login do Qoder neste computador (qodercli login). Você também pode digitar um ID de modelo.",
  "Models available to this computer's CodeBuddy Code login. You can also type a model ID.":
    "Modelos disponíveis para o login do CodeBuddy Code neste computador. Você também pode digitar um ID de modelo.",
  "Models available to this computer's Antigravity login. AGY configured default lets Antigravity choose. You can also type a model ID.":
    "Modelos disponíveis para o login do Antigravity neste computador. AGY configured default deixa o Antigravity escolher. Você também pode digitar um ID de modelo.",
  // Field labels
  "API Key": "Chave de API",
  "Authentication": "Autenticação",
  "API URL": "URL da API",
  "Base URL": "URL base",
  "Claude Command": "Comando do Claude",
  "Effort": "Esforço de raciocínio",
  "Environment Variables": "Variáveis de ambiente",
  "Fast mode": "Modo rápido",
  "Fast tier": "Nível rápido",
  "Load local Pi extensions": "Carregar extensões locais do Pi",
  "Model": "Modelo",
  "Model ID": "ID do modelo",
  "Provider": "Provedor",
  "Reasoning": "Raciocínio",
  "Supports image input": "Aceita entrada de imagem",
  "Thinking effort": "Esforço de pensamento",
  "Tier": "Nível",
  // Field hints
  "Available values are declared by the selected model.":
    "Os valores disponíveis são definidos pelo modelo selecionado.",
  "Available values depend on the selected model.": "Os valores disponíveis dependem do modelo selecionado.",
  "Built-in Pi is ready to use without local runtime setup. It uses the provider key entered here.":
    "O Built-in Pi está pronto para uso, sem configurar um runtime local. Ele usa a chave do provedor inserida aqui.",
  "Configured uses your machine's Pi auth.json. Other options inject the matching API key as an env var so the Pi SDK picks it up — no auth.json edit on your machine.":
    "A opção “Configurado” usa o auth.json do Pi do seu computador. As outras opções injetam a chave de API correspondente como variável de ambiente para que o SDK do Pi a utilize, sem editar o auth.json no seu computador.",
  "Default leaves Claude Code provider settings untouched. Custom sets ANTHROPIC_BASE_URL and, from the key, ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN for this agent.":
    "A opção Padrão não altera as configurações de provedor do Claude Code. A opção Personalizado define ANTHROPIC_BASE_URL e, com a chave, ANTHROPIC_API_KEY ou ANTHROPIC_AUTH_TOKEN para este agente.",
  "Use Bearer token for a gateway that expects an Authorization header.": "Use Bearer token para um gateway que espera um cabeçalho Authorization.",
  "Context window (tokens)": "Janela de contexto (tokens)",
  "Optional. Overrides the model's context window. Leave empty to use the listed model's own value or Raft's default. A gateway can provide both limits automatically. [Learn more](https://docs.raft.build/developers/gateway-model-limits/)":
    "Opcional. Substitui a janela de contexto do modelo. Deixe vazio para usar o valor do próprio modelo da lista ou o padrão do Raft. Um gateway pode fornecer os dois limites automaticamente. [Saiba mais](https://docs.raft.build/developers/gateway-model-limits/)",
  "Max output tokens": "Máximo de tokens de saída",
  "Optional. Overrides the most tokens the model may write in one reply. Leave empty to use the listed model's own value or Raft's default. A gateway can provide both limits automatically. [Learn more](https://docs.raft.build/developers/gateway-model-limits/)":
    "Opcional. Substitui o máximo que o modelo pode escrever em uma resposta. Deixe vazio para usar o valor do próprio modelo da lista ou o padrão do Raft. Um gateway pode fornecer os dois limites automaticamente. [Saiba mais](https://docs.raft.build/developers/gateway-model-limits/)",
  "Enable only when this gateway endpoint and model accept images.":
    "Ative somente se este endpoint do gateway e o modelo aceitarem imagens.",
  "Executable path or command name; Slock adds the Claude stream-json runtime arguments.":
    "Caminho do executável ou nome do comando; o Slock adiciona os argumentos de runtime stream-json do Claude.",
  "Launch this runtime with higher speed at a higher cost per token.":
    "Inicia este runtime com mais velocidade, a um custo maior por token.",
  "Load enabled Pi extensions installed on the computer running this agent. Applying changes restarts a running agent.":
    "Carrega as extensões do Pi instaladas e ativadas no computador que executa este agente. Aplicar as alterações reinicia o agente, se ele estiver em execução.",
  "Models Claude Code accepts. You can also type a model ID.":
    "Modelos aceitos pelo Claude Code. Você também pode digitar um ID de modelo.",
  "Models GitHub Copilot CLI accepts. You can also type a model ID.":
    "Modelos aceitos pelo GitHub Copilot CLI. Você também pode digitar um ID de modelo.",
  "Models available from this computer's Codex CLI. You can also type a model ID.":
    "Modelos disponíveis no Codex CLI deste computador. Você também pode digitar um ID de modelo.",
  "Models available from this computer's Cursor CLI. You can also type a model ID.":
    "Modelos disponíveis no Cursor CLI deste computador. Você também pode digitar um ID de modelo.",
  "Models available from this computer's Grok CLI.": "Modelos disponíveis no Grok CLI deste computador.",
  "Models available from this computer's Kimi CLI configuration.":
    "Modelos disponíveis na configuração do Kimi CLI deste computador.",
  "Models available from this computer's Kimi configuration.":
    "Modelos disponíveis na configuração do Kimi deste computador.",
  "Models available from this computer's OpenCode configuration.":
    "Modelos disponíveis na configuração do OpenCode deste computador.",
  "Models available from this computer's Pi configuration. You can also type a model ID.":
    "Modelos disponíveis na configuração do Pi deste computador. Você também pode digitar um ID de modelo.",
  "Models the selected provider offers.": "Modelos oferecidos pelo provedor selecionado.",
  "These will be injected into the runtime command environment.":
    "Elas serão injetadas no ambiente do comando do runtime.",
  "Use a model ID the selected provider supports.": "Use um ID de modelo compatível com o provedor selecionado.",
  // Choice descriptions. Effort level names stay English, as in the web app.
  "No reasoning": "Sem raciocínio",
  "Answers directly, without a thinking phase": "Responde diretamente, sem uma etapa de raciocínio",
  "Very light reasoning for the fastest responses": "Raciocínio bem leve para as respostas mais rápidas",
  "Fast responses with lighter reasoning": "Respostas rápidas com raciocínio mais leve",
  "Balances speed and reasoning depth for everyday tasks":
    "Equilibra velocidade e profundidade de raciocínio para tarefas do dia a dia",
  "Greater reasoning depth for complex problems": "Raciocínio mais profundo para problemas complexos",
  "Extra high reasoning depth for complex problems": "Raciocínio extremamente profundo para problemas complexos",
  "Maximum reasoning depth for the hardest problems":
    "Profundidade máxima de raciocínio para os problemas mais difíceis",
  "Maximum reasoning with automatic task delegation": "Raciocínio máximo com delegação automática de tarefas",
  "Lower latency": "Menor latência",
  // Generic option labels (model and provider names are never translated)
  "Auto": "Automático",
  "Configured": "Configurado",
  "Configured Default": "Padrão configurado",
  "Configured Default / Auto": "Padrão configurado / Automático",
  "API key (x-api-key)": "Chave de API (x-api-key)",
  "Bearer token (Authorization)": "Bearer token (Authorization)",
  "Custom": "Personalizado",
  "Default": "Padrão",
  // v3 unavailableOptions reasons for a saved connection
  "This saved provider is disabled.": "Este provedor salvo está desativado.",
  "This saved provider has no credential.": "Este provedor salvo não tem credencial.",
});

const RU: Readonly<Record<string, string>> = Object.freeze({
  "Models from this computer's Qwen Code settings. You can also type a model ID. Qwen Code has no login: set its provider with OPENAI_API_KEY, OPENAI_BASE_URL and OPENAI_MODEL under Environment Variables.":
    "Модели из настроек Qwen Code на этом компьютере. Можно также ввести ID модели. Входа в Qwen Code нет: задайте провайдера через OPENAI_API_KEY, OPENAI_BASE_URL и OPENAI_MODEL в разделе «Переменные окружения».",
  "Models available to this computer's Qoder login (qodercli login). You can also type a model ID.":
    "Модели, доступные аккаунту Qoder, под которым выполнен вход на этом компьютере (qodercli login). Можно также ввести ID модели.",
  "Models available to this computer's CodeBuddy Code login. You can also type a model ID.":
    "Модели, доступные аккаунту CodeBuddy Code, под которым выполнен вход на этом компьютере. Можно также ввести ID модели.",
  "Models available to this computer's Antigravity login. AGY configured default lets Antigravity choose. You can also type a model ID.":
    "Модели, доступные аккаунту Antigravity, под которым выполнен вход на этом компьютере. AGY configured default оставляет выбор за Antigravity. Можно также ввести ID модели.",
  // Field labels
  "API Key": "Ключ API",
  "Authentication": "Аутентификация",
  "API URL": "URL API",
  "Base URL": "Базовый URL",
  "Claude Command": "Команда Claude",
  "Effort": "Глубина рассуждений",
  "Environment Variables": "Переменные окружения",
  "Fast mode": "Быстрый режим",
  "Fast tier": "Быстрый уровень",
  "Load local Pi extensions": "Загружать локальные расширения Pi",
  "Model": "Модель",
  "Model ID": "ID модели",
  "Provider": "Провайдер",
  "Reasoning": "Рассуждения",
  "Supports image input": "Поддерживает ввод изображений",
  "Thinking effort": "Глубина размышлений",
  "Tier": "Уровень",
  // Field hints
  "Available values are declared by the selected model.": "Доступные значения задаёт выбранная модель.",
  "Available values depend on the selected model.": "Доступные значения зависят от выбранной модели.",
  "Built-in Pi is ready to use without local runtime setup. It uses the provider key entered here.":
    "Среда выполнения Built-in Pi готова к работе без локальной настройки. Она использует ключ провайдера, указанный здесь.",
  "Configured uses your machine's Pi auth.json. Other options inject the matching API key as an env var so the Pi SDK picks it up — no auth.json edit on your machine.":
    "Вариант «Настроенный» использует файл auth.json Pi на вашем компьютере. Остальные варианты передают нужный ключ API в переменной окружения, и Pi SDK подхватывает его — править auth.json на компьютере не нужно.",
  "Default leaves Claude Code provider settings untouched. Custom sets ANTHROPIC_BASE_URL and, from the key, ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN for this agent.":
    "Вариант «По умолчанию» не меняет настройки провайдера Claude Code. Вариант «Пользовательский» задаёт для этого агента ANTHROPIC_BASE_URL и передаёт ключ как ANTHROPIC_API_KEY или ANTHROPIC_AUTH_TOKEN.",
  "Use Bearer token for a gateway that expects an Authorization header.": "Выберите Bearer token, если шлюз ожидает заголовок Authorization.",
  "Context window (tokens)": "Контекстное окно (токены)",
  "Optional. Overrides the model's context window. Leave empty to use the listed model's own value or Raft's default. A gateway can provide both limits automatically. [Learn more](https://docs.raft.build/developers/gateway-model-limits/)":
    "Необязательно. Заменяет контекстное окно модели. Оставьте пустым, чтобы использовать значение самой модели из списка или значение Raft по умолчанию. Шлюз может передавать оба лимита автоматически. [Подробнее](https://docs.raft.build/developers/gateway-model-limits/)",
  "Max output tokens": "Максимум токенов в ответе",
  "Optional. Overrides the most tokens the model may write in one reply. Leave empty to use the listed model's own value or Raft's default. A gateway can provide both limits automatically. [Learn more](https://docs.raft.build/developers/gateway-model-limits/)":
    "Необязательно. Заменяет, сколько токенов модель может написать в одном ответе. Оставьте пустым, чтобы использовать значение самой модели из списка или значение Raft по умолчанию. Шлюз может передавать оба лимита автоматически. [Подробнее](https://docs.raft.build/developers/gateway-model-limits/)",
  "Enable only when this gateway endpoint and model accept images.":
    "Включайте, только если этот эндпоинт шлюза и модель принимают изображения.",
  "Executable path or command name; Slock adds the Claude stream-json runtime arguments.":
    "Путь к исполняемому файлу или имя команды; Slock сам добавит аргументы запуска Claude в режиме stream-json.",
  "Launch this runtime with higher speed at a higher cost per token.":
    "Среда выполнения работает быстрее, но каждый токен стоит дороже.",
  "Load enabled Pi extensions installed on the computer running this agent. Applying changes restarts a running agent.":
    "Будут загружены включённые расширения Pi, установленные на компьютере, где работает этот агент. Если агент запущен, применение изменений перезапустит его.",
  "Models Claude Code accepts. You can also type a model ID.":
    "Модели, которые поддерживает Claude Code. Можно также ввести ID модели.",
  "Models GitHub Copilot CLI accepts. You can also type a model ID.":
    "Модели, которые поддерживает GitHub Copilot CLI. Можно также ввести ID модели.",
  "Models available from this computer's Codex CLI. You can also type a model ID.":
    "Модели, доступные в Codex CLI на этом компьютере. Можно также ввести ID модели.",
  "Models available from this computer's Cursor CLI. You can also type a model ID.":
    "Модели, доступные в Cursor CLI на этом компьютере. Можно также ввести ID модели.",
  "Models available from this computer's Grok CLI.": "Модели, доступные в Grok CLI на этом компьютере.",
  "Models available from this computer's Kimi CLI configuration.":
    "Модели, доступные в конфигурации Kimi CLI на этом компьютере.",
  "Models available from this computer's Kimi configuration.":
    "Модели, доступные в конфигурации Kimi на этом компьютере.",
  "Models available from this computer's OpenCode configuration.":
    "Модели, доступные в конфигурации OpenCode на этом компьютере.",
  "Models available from this computer's Pi configuration. You can also type a model ID.":
    "Модели, доступные в конфигурации Pi на этом компьютере. Можно также ввести ID модели.",
  "Models the selected provider offers.": "Модели, которые предлагает выбранный провайдер.",
  "These will be injected into the runtime command environment.":
    "Эти переменные будут добавлены в окружение команды среды выполнения.",
  "Use a model ID the selected provider supports.": "Укажите ID модели, который поддерживает выбранный провайдер.",
  // Choice descriptions. Effort level names stay English, as in the web app.
  "No reasoning": "Без рассуждений",
  "Answers directly, without a thinking phase": "Отвечает сразу, без этапа размышлений",
  "Very light reasoning for the fastest responses": "Минимальные рассуждения для самых быстрых ответов",
  "Fast responses with lighter reasoning": "Быстрые ответы с неглубокими рассуждениями",
  "Balances speed and reasoning depth for everyday tasks":
    "Баланс скорости и глубины рассуждений для повседневных задач",
  "Greater reasoning depth for complex problems": "Более глубокие рассуждения для сложных задач",
  "Extra high reasoning depth for complex problems": "Очень глубокие рассуждения для сложных задач",
  "Maximum reasoning depth for the hardest problems":
    "Максимально глубокие рассуждения для самых трудных задач",
  "Maximum reasoning with automatic task delegation": "Максимальная глубина рассуждений и автоматическое делегирование задач",
  "Lower latency": "Меньшая задержка",
  // Generic option labels (model and provider names are never translated)
  "Auto": "Авто",
  "Configured": "Настроенный",
  "Configured Default": "По умолчанию из настроек",
  "Configured Default / Auto": "По умолчанию из настроек / Авто",
  "API key (x-api-key)": "Ключ API (x-api-key)",
  "Bearer token (Authorization)": "Bearer token (Authorization)",
  "Custom": "Пользовательский",
  "Default": "По умолчанию",
  // v3 unavailableOptions reasons for a saved connection
  "This saved provider is disabled.": "Этот сохранённый провайдер отключён.",
  "This saved provider has no credential.": "У этого сохранённого провайдера нет учётных данных.",
});

const KO: Readonly<Record<string, string>> = Object.freeze({
  "Models from this computer's Qwen Code settings. You can also type a model ID. Qwen Code has no login: set its provider with OPENAI_API_KEY, OPENAI_BASE_URL and OPENAI_MODEL under Environment Variables.":
    "이 컴퓨터의 Qwen Code 설정에 있는 모델입니다. 모델 ID를 직접 입력할 수도 있습니다. Qwen Code에는 로그인이 없습니다. 환경 변수의 OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL로 공급자를 설정하세요.",
  "Models available to this computer's Qoder login (qodercli login). You can also type a model ID.":
    "이 컴퓨터의 Qoder 로그인(qodercli login)으로 사용할 수 있는 모델입니다. 모델 ID를 직접 입력할 수도 있습니다.",
  "Models available to this computer's CodeBuddy Code login. You can also type a model ID.":
    "이 컴퓨터의 CodeBuddy Code 로그인으로 사용할 수 있는 모델입니다. 모델 ID를 직접 입력할 수도 있습니다.",
  "Models available to this computer's Antigravity login. AGY configured default lets Antigravity choose. You can also type a model ID.":
    "이 컴퓨터의 Antigravity 로그인으로 사용할 수 있는 모델입니다. AGY configured default를 고르면 Antigravity가 선택합니다. 모델 ID를 직접 입력할 수도 있습니다.",
  // Field labels
  "API Key": "API 키",
  "Authentication": "인증",
  "API URL": "API URL",
  "Base URL": "Base URL",
  "Claude Command": "Claude 명령어",
  "Effort": "추론 강도",
  "Environment Variables": "환경 변수",
  "Fast mode": "빠른 모드",
  "Fast tier": "빠른 티어",
  "Load local Pi extensions": "로컬 Pi 확장 불러오기",
  "Model": "모델",
  "Model ID": "모델 ID",
  "Provider": "제공업체",
  "Reasoning": "추론 강도",
  "Supports image input": "이미지 입력 지원",
  "Thinking effort": "사고 강도",
  "Tier": "티어",
  // Field hints
  "Available values are declared by the selected model.": "선택할 수 있는 값은 선택한 모델이 정해요.",
  "Available values depend on the selected model.": "선택할 수 있는 값은 선택한 모델에 따라 달라요.",
  "Built-in Pi is ready to use without local runtime setup. It uses the provider key entered here.":
    "Built-in Pi는 로컬 런타임 설정 없이 바로 사용할 수 있어요. 여기에 입력한 제공업체 키를 사용해요.",
  "Configured uses your machine's Pi auth.json. Other options inject the matching API key as an env var so the Pi SDK picks it up — no auth.json edit on your machine.":
    "‘설정됨’은 내 컴퓨터의 Pi auth.json을 사용해요. 다른 옵션은 해당 API 키를 환경 변수로 주입해 Pi SDK가 읽도록 하므로, 컴퓨터의 auth.json을 수정하지 않아도 돼요.",
  "Default leaves Claude Code provider settings untouched. Custom sets ANTHROPIC_BASE_URL and, from the key, ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN for this agent.":
    "기본값은 Claude Code의 제공업체 설정을 그대로 둬요. 사용자 지정은 이 에이전트에 ANTHROPIC_BASE_URL을 설정하고, 키를 ANTHROPIC_API_KEY 또는 ANTHROPIC_AUTH_TOKEN으로 설정해요.",
  "Use Bearer token for a gateway that expects an Authorization header.": "Authorization 헤더를 요구하는 게이트웨이에는 Bearer token을 선택하세요.",
  "Context window (tokens)": "컨텍스트 창(토큰)",
  "Optional. Overrides the model's context window. Leave empty to use the listed model's own value or Raft's default. A gateway can provide both limits automatically. [Learn more](https://docs.raft.build/developers/gateway-model-limits/)":
    "선택 사항. 이 모델의 컨텍스트 창을 덮어씁니다. 비워 두면 목록에 있는 모델 자체의 값이나 Raft 기본값을 씁니다. 게이트웨이가 두 한도를 자동으로 제공할 수 있습니다. [자세히 알아보기](https://docs.raft.build/developers/gateway-model-limits/)",
  "Max output tokens": "최대 출력 토큰",
  "Optional. Overrides the most tokens the model may write in one reply. Leave empty to use the listed model's own value or Raft's default. A gateway can provide both limits automatically. [Learn more](https://docs.raft.build/developers/gateway-model-limits/)":
    "선택 사항. 모델이 한 번 답할 때 쓸 수 있는 최대 토큰 수를 덮어씁니다. 비워 두면 목록에 있는 모델 자체의 값이나 Raft 기본값을 씁니다. 게이트웨이가 두 한도를 자동으로 제공할 수 있습니다. [자세히 알아보기](https://docs.raft.build/developers/gateway-model-limits/)",
  "Enable only when this gateway endpoint and model accept images.": "이 게이트웨이 엔드포인트와 모델이 이미지를 지원할 때만 켜 주세요.",
  "Executable path or command name; Slock adds the Claude stream-json runtime arguments.":
    "실행 파일 경로 또는 명령어 이름이에요. Slock이 Claude stream-json 런타임 인수를 추가해요.",
  "Launch this runtime with higher speed at a higher cost per token.": "토큰당 비용이 더 높은 대신 더 빠른 속도로 이 런타임을 실행해요.",
  "Load enabled Pi extensions installed on the computer running this agent. Applying changes restarts a running agent.":
    "이 에이전트를 실행하는 컴퓨터에 설치되어 있고 활성화된 Pi 확장을 불러와요. 변경 사항을 적용하면 실행 중인 에이전트가 다시 시작돼요.",
  "Models Claude Code accepts. You can also type a model ID.": "Claude Code에서 사용할 수 있는 모델이에요. 모델 ID를 직접 입력할 수도 있어요.",
  "Models GitHub Copilot CLI accepts. You can also type a model ID.": "GitHub Copilot CLI에서 사용할 수 있는 모델이에요. 모델 ID를 직접 입력할 수도 있어요.",
  "Models available from this computer's Codex CLI. You can also type a model ID.":
    "이 컴퓨터의 Codex CLI에서 사용할 수 있는 모델이에요. 모델 ID를 직접 입력할 수도 있어요.",
  "Models available from this computer's Cursor CLI. You can also type a model ID.":
    "이 컴퓨터의 Cursor CLI에서 사용할 수 있는 모델이에요. 모델 ID를 직접 입력할 수도 있어요.",
  "Models available from this computer's Grok CLI.": "이 컴퓨터의 Grok CLI에서 사용할 수 있는 모델이에요.",
  "Models available from this computer's Kimi CLI configuration.": "이 컴퓨터의 Kimi CLI 설정에서 사용할 수 있는 모델이에요.",
  "Models available from this computer's Kimi configuration.": "이 컴퓨터의 Kimi 설정에서 사용할 수 있는 모델이에요.",
  "Models available from this computer's OpenCode configuration.": "이 컴퓨터의 OpenCode 설정에서 사용할 수 있는 모델이에요.",
  "Models available from this computer's Pi configuration. You can also type a model ID.":
    "이 컴퓨터의 Pi 설정에서 사용할 수 있는 모델이에요. 모델 ID를 직접 입력할 수도 있어요.",
  "Models the selected provider offers.": "선택한 제공업체가 제공하는 모델이에요.",
  "These will be injected into the runtime command environment.": "런타임 명령 환경에 주입돼요.",
  "Use a model ID the selected provider supports.": "선택한 제공업체가 지원하는 모델 ID를 입력하세요.",
  // Choice descriptions. Effort level names stay English, as in the web app.
  "No reasoning": "추론 안 함",
  "Answers directly, without a thinking phase": "생각 단계 없이 바로 답해요",
  "Very light reasoning for the fastest responses": "아주 가벼운 추론으로 가장 빠르게 응답해요",
  "Fast responses with lighter reasoning": "가벼운 추론으로 빠르게 응답해요",
  "Balances speed and reasoning depth for everyday tasks": "일상적인 작업에 맞게 속도와 추론 깊이의 균형을 맞춰요",
  "Greater reasoning depth for complex problems": "복잡한 문제를 더 깊이 추론해요",
  "Extra high reasoning depth for complex problems": "복잡한 문제를 훨씬 더 깊이 추론해요",
  "Maximum reasoning depth for the hardest problems": "가장 어려운 문제를 최대한 깊이 추론해요",
  "Maximum reasoning with automatic task delegation": "최대 수준으로 추론하고 작업을 자동으로 위임해요",
  "Lower latency": "더 낮은 지연 시간",
  // Generic option labels (model and provider names are never translated)
  "Auto": "자동",
  "Configured": "설정됨",
  "Configured Default": "설정된 기본값",
  "Configured Default / Auto": "설정된 기본값 / 자동",
  "API key (x-api-key)": "API 키 (x-api-key)",
  "Bearer token (Authorization)": "Bearer token (Authorization)",
  "Custom": "사용자 지정",
  "Default": "기본값",
  // v3 unavailableOptions reasons for a saved connection
  "This saved provider is disabled.": "이 저장된 제공업체는 비활성화되어 있어요.",
  "This saved provider has no credential.": "이 저장된 제공업체에 자격 증명이 없어요.",
});

const ZH_TW: Readonly<Record<string, string>> = Object.freeze({
  "Models from this computer's Qwen Code settings. You can also type a model ID. Qwen Code has no login: set its provider with OPENAI_API_KEY, OPENAI_BASE_URL and OPENAI_MODEL under Environment Variables.":
    "這台電腦上 Qwen Code 設定裡的模型。也可以直接填寫模型 ID。Qwen Code 沒有登入：在環境變數裡用 OPENAI_API_KEY、OPENAI_BASE_URL 和 OPENAI_MODEL 設定它的模型服務。",
  "Models available to this computer's Qoder login (qodercli login). You can also type a model ID.":
    "這台電腦上 Qoder 登入（qodercli login）可用的模型。也可以直接填寫模型 ID。",
  "Models available to this computer's CodeBuddy Code login. You can also type a model ID.":
    "這台電腦上 CodeBuddy Code 登入可用的模型。也可以直接填寫模型 ID。",
  "Models available to this computer's Antigravity login. AGY configured default lets Antigravity choose. You can also type a model ID.":
    "這台電腦上 Antigravity 登入可用的模型。選擇 AGY configured default 則由 Antigravity 自行決定。也可以直接填寫模型 ID。",
  // Field labels
  "API Key": "API 金鑰",
  "Authentication": "驗證",
  "API URL": "API URL",
  "Base URL": "Base URL",
  "Claude Command": "Claude 指令",
  "Effort": "推理強度",
  "Environment Variables": "環境變數",
  "Fast mode": "快速模式",
  "Fast tier": "快速方案",
  "Load local Pi extensions": "載入本機 Pi 擴充功能",
  "Model": "模型",
  "Model ID": "模型 ID",
  "Provider": "供應商",
  "Reasoning": "推理強度",
  "Supports image input": "支援圖片輸入",
  "Thinking effort": "思考強度",
  "Tier": "方案",
  // Field hints
  "Available values are declared by the selected model.": "可選的值由所選模型決定。",
  "Available values depend on the selected model.": "可選的值取決於所選模型。",
  "Built-in Pi is ready to use without local runtime setup. It uses the provider key entered here.":
    "Built-in Pi 不需要在本機設定執行環境即可使用，並會使用在此輸入的供應商金鑰。",
  "Configured uses your machine's Pi auth.json. Other options inject the matching API key as an env var so the Pi SDK picks it up — no auth.json edit on your machine.":
    "「已設定」會使用你電腦上的 Pi auth.json。其他選項會將對應的 API 金鑰以環境變數注入，讓 Pi SDK 自動讀取——不需要修改你電腦上的 auth.json。",
  "Default leaves Claude Code provider settings untouched. Custom sets ANTHROPIC_BASE_URL and, from the key, ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN for this agent.":
    "「預設」不會變更 Claude Code 的供應商設定。「自訂」會為此 Agent 設定 ANTHROPIC_BASE_URL，並依所選方式把金鑰設為 ANTHROPIC_API_KEY 或 ANTHROPIC_AUTH_TOKEN。",
  "Use Bearer token for a gateway that expects an Authorization header.": "閘道要求 Authorization 標頭時，請選擇 Bearer token。",
  "Context window (tokens)": "上下文視窗（token）",
  "Optional. Overrides the model's context window. Leave empty to use the listed model's own value or Raft's default. A gateway can provide both limits automatically. [Learn more](https://docs.raft.build/developers/gateway-model-limits/)":
    "選填。覆寫此模型的上下文視窗。留空則使用清單中此模型本身的值，或 Raft 的預設值。閘道可以自動提供這兩個上限。[瞭解詳情](https://docs.raft.build/developers/gateway-model-limits/)",
  "Max output tokens": "單次最大輸出 token",
  "Optional. Overrides the most tokens the model may write in one reply. Leave empty to use the listed model's own value or Raft's default. A gateway can provide both limits automatically. [Learn more](https://docs.raft.build/developers/gateway-model-limits/)":
    "選填。覆寫模型一次回覆最多能寫的 token 數。留空則使用清單中此模型本身的值，或 Raft 的預設值。閘道可以自動提供這兩個上限。[瞭解詳情](https://docs.raft.build/developers/gateway-model-limits/)",
  "Enable only when this gateway endpoint and model accept images.": "僅在此 gateway 端點與模型接受圖片時啟用。",
  "Executable path or command name; Slock adds the Claude stream-json runtime arguments.":
    "執行檔路徑或指令名稱；Slock 會附加 Claude stream-json 執行環境參數。",
  "Launch this runtime with higher speed at a higher cost per token.": "以更快的速度啟動此執行環境，但每個 Token 的成本較高。",
  "Load enabled Pi extensions installed on the computer running this agent. Applying changes restarts a running agent.":
    "載入執行此 Agent 的電腦上已安裝並啟用的 Pi 擴充功能。套用變更會重新啟動執行中的 Agent。",
  "Models Claude Code accepts. You can also type a model ID.": "Claude Code 支援的模型。你也可以直接輸入模型 ID。",
  "Models GitHub Copilot CLI accepts. You can also type a model ID.": "GitHub Copilot CLI 支援的模型。你也可以直接輸入模型 ID。",
  "Models available from this computer's Codex CLI. You can also type a model ID.":
    "這台電腦的 Codex CLI 可用的模型。你也可以直接輸入模型 ID。",
  "Models available from this computer's Cursor CLI. You can also type a model ID.":
    "這台電腦的 Cursor CLI 可用的模型。你也可以直接輸入模型 ID。",
  "Models available from this computer's Grok CLI.": "這台電腦的 Grok CLI 可用的模型。",
  "Models available from this computer's Kimi CLI configuration.": "這台電腦的 Kimi CLI 設定中可用的模型。",
  "Models available from this computer's Kimi configuration.": "這台電腦的 Kimi 設定中可用的模型。",
  "Models available from this computer's OpenCode configuration.": "這台電腦的 OpenCode 設定中可用的模型。",
  "Models available from this computer's Pi configuration. You can also type a model ID.":
    "這台電腦的 Pi 設定中可用的模型。你也可以直接輸入模型 ID。",
  "Models the selected provider offers.": "所選供應商提供的模型。",
  "These will be injected into the runtime command environment.": "這些變數會注入執行環境的指令環境中。",
  "Use a model ID the selected provider supports.": "請使用所選供應商支援的模型 ID。",
  // Choice descriptions. Effort level names stay English, as in the web app.
  "No reasoning": "不推理",
  "Answers directly, without a thinking phase": "直接回答，不經過思考階段",
  "Very light reasoning for the fastest responses": "極少量推理，回應最快",
  "Fast responses with lighter reasoning": "回應快速，推理較輕量",
  "Balances speed and reasoning depth for everyday tasks": "兼顧速度與推理深度，適合日常任務",
  "Greater reasoning depth for complex problems": "為複雜問題提供更深入的推理",
  "Extra high reasoning depth for complex problems": "為複雜問題提供極深入的推理",
  "Maximum reasoning depth for the hardest problems": "為最困難的問題提供最高推理深度",
  "Maximum reasoning with automatic task delegation": "最高推理深度，並自動委派任務",
  "Lower latency": "延遲更低",
  // Generic option labels (model and provider names are never translated)
  "Auto": "自動",
  "Configured": "已設定",
  "Configured Default": "已設定的預設值",
  "Configured Default / Auto": "已設定的預設值 / 自動",
  "API key (x-api-key)": "API 金鑰（x-api-key）",
  "Bearer token (Authorization)": "Bearer token（Authorization）",
  "Custom": "自訂",
  "Default": "預設",
  // v3 unavailableOptions reasons for a saved connection
  "This saved provider is disabled.": "這個已儲存的供應商已停用。",
  "This saved provider has no credential.": "這個已儲存的供應商缺少憑證。",
});

const TRANSLATIONS: Readonly<Record<Exclude<RuntimeFormCopyLocale, "en">, Readonly<Record<string, string>>>> = Object.freeze({
  es: ES,
  "pt-br": PT_BR,
  ru: RU,
  "zh-cn": ZH_CN,
  ja: JA,
  ko: KO,
  "zh-tw": ZH_TW,
});

/** The zh-CN table, for tests that check every shipped string has a translation. */
export const RUNTIME_FORM_V2_ZH_CN_COPY = ZH_CN;

/** Every non-English table, for tests that check the tables translate the same strings. */
export const RUNTIME_FORM_V2_COPY_TABLES = TRANSLATIONS;

/**
 * The copy language for an `Accept-Language` header: the highest-q range that
 * names a language we have a catalog for (the shared display-locale matcher:
 * Chinese by script, `pt-PT` takes the Brazilian table), else English.
 */
export function runtimeFormCopyLocale(acceptLanguage: string | undefined): RuntimeFormCopyLocale {
  if (!acceptLanguage) return "en";
  const ranges = acceptLanguage
    .split(",")
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim().toLowerCase()).find((p) => p.startsWith("q="));
      const quality = q === undefined ? 1 : Number(q.slice(2));
      return { tag: tag.trim(), quality: Number.isFinite(quality) ? quality : 0, index };
    })
    .filter((range) => range.tag !== "" && range.quality > 0)
    .sort((a, b) => b.quality - a.quality || a.index - b.index);
  for (const { tag } of ranges) {
    const locale = matchDisplayLocale(tag);
    if (locale) return locale;
  }
  return "en";
}

function translate(text: string, table: Readonly<Record<string, string>>): string {
  return Object.hasOwn(table, text) ? table[text] : text;
}

/** The form with its display copy in `locale`; English returns the form unchanged. */
export function localizeRuntimeFormV2<T extends RuntimeFormV2Definition>(form: T, locale: RuntimeFormCopyLocale): T {
  if (locale === "en") return form;
  const table = TRANSLATIONS[locale];
  const localization = form.uiSchema?.localization;
  if (!localization) return form;
  const localized = structuredClone(form);
  for (const copy of Object.values(localized.uiSchema!.localization!)) {
    if (typeof copy.label === "string") copy.label = translate(copy.label, table);
    if (typeof copy.hint === "string") copy.hint = translate(copy.hint, table);
    if (typeof copy.placeholder === "string") copy.placeholder = translate(copy.placeholder, table);
    for (const choice of Object.values(copy.choices ?? {})) {
      choice.label = translate(choice.label, table);
      if (typeof choice.description === "string") choice.description = translate(choice.description, table);
    }
  }
  return localized;
}

function localizeOptions(options: RuntimeFormV2Option[], table: Readonly<Record<string, string>>): RuntimeFormV2Option[] {
  return options.map((option) => (
    typeof option.label === "string" ? { ...option, label: translate(option.label, table) } : option
  ));
}

/** The option source with its generic option labels in `locale`; values never change. */
export function localizeRuntimeFormV2OptionSource<T extends { options?: unknown; optionsByValue?: unknown; unavailableOptions?: unknown }>(
  source: T,
  locale: RuntimeFormCopyLocale,
): T {
  if (locale === "en") return source;
  const table = TRANSLATIONS[locale];
  const localized = { ...source };
  if (Array.isArray(source.options)) {
    localized.options = localizeOptions(source.options as RuntimeFormV2Option[], table);
  }
  // v3: a saved connection's unavailable entry carries server copy (a model's
  // reason is the runtime's own text and stays as sent).
  if (Array.isArray(source.unavailableOptions)) {
    localized.unavailableOptions = (source.unavailableOptions as Array<Record<string, unknown>>).map((option) => (
      typeof option.connectionId === "string" && typeof option.reason === "string" ? { ...option, reason: translate(option.reason, table) } : option
    ));
  }
  if (source.optionsByValue && typeof source.optionsByValue === "object") {
    localized.optionsByValue = Object.fromEntries(
      Object.entries(source.optionsByValue as Record<string, RuntimeFormV2Option[]>).map(([value, options]) => [
        value,
        Array.isArray(options) ? localizeOptions(options, table) : options,
      ]),
    );
  }
  return localized;
}

/** Marks a localized response so caches keep one copy per language. */
export function setRuntimeFormCopyHeaders(res: Response, locale: RuntimeFormCopyLocale): void {
  res.setHeader("Content-Language", displayLocaleTag(locale));
  res.vary("Accept-Language");
}
