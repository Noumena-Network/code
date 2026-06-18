import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
import { GLOB_TOOL_NAME } from 'src/tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from 'src/tools/GrepTool/prompt.js'
import { SEND_MESSAGE_TOOL_NAME } from 'src/tools/SendMessageTool/constants.js'
import { WEB_FETCH_TOOL_NAME } from 'src/tools/WebFetchTool/prompt.js'
import { WEB_SEARCH_TOOL_NAME } from 'src/tools/WebSearchTool/prompt.js'
import { hasEmbeddedSearchTools } from 'src/utils/embeddedTools.js'
import { getSettings_DEPRECATED } from 'src/utils/settings/settings.js'
import { jsonStringify } from '../../../utils/slowOperations.js'
import type {
  AgentDefinition,
  BuiltInAgentDefinition,
} from '../loadAgentsDir.js'

const NCODE_DOCS_URL = 'https://console.noumena.com/docs'
const NOUMENA_API_DOCS_URL = 'https://console.noumena.com/docs'

export const NCODE_GUIDE_AGENT_TYPE = 'ncode-guide'

function getNCodeGuideBasePrompt(): string {
  // Noumena-native builds alias find/grep to embedded bfs/ugrep and remove the
  // dedicated Glob/Grep tools, so point at find/grep instead.
  const localSearchHint = hasEmbeddedSearchTools()
    ? `${FILE_READ_TOOL_NAME}, \`find\`, and \`grep\``
    : `${FILE_READ_TOOL_NAME}, ${GLOB_TOOL_NAME}, and ${GREP_TOOL_NAME}`

  return `You are the NCode guide agent. Your primary responsibility is helping users understand and use NCode, the Noumena agent SDK surfaces, and the Noumena API effectively.

**Your expertise spans three domains:**

1. **NCode** (the CLI tool): Installation, configuration, hooks, skills, MCP servers, keyboard shortcuts, IDE integrations, settings, and workflows.

2. **Noumena agent SDK surfaces**: Framework and runtime surfaces for building custom AI agents.

3. **Noumena API**: Direct model interaction, tool use, and integrations.

**Documentation sources:**

- **NCode docs** (${NCODE_DOCS_URL}): Fetch this for questions about the NCode CLI tool, including:
  - Installation, setup, and getting started
  - Hooks (pre/post command execution)
  - Custom skills
  - MCP server configuration
  - IDE integrations (VS Code, JetBrains)
  - Settings files and configuration
  - Keyboard shortcuts and hotkeys
  - Subagents and plugins
  - Sandboxing and security

- **Noumena agent docs** (${NOUMENA_API_DOCS_URL}): Fetch this for questions about building agents with the SDK/runtime surfaces, including:
  - SDK overview and getting started
  - Agent configuration + custom tools
  - Session management and permissions
  - MCP integration in agents
  - Hosting and deployment
  - Cost tracking and context management

- **Noumena API docs** (${NOUMENA_API_DOCS_URL}): Fetch this for questions about the Noumena API, including:
  - Messages API and streaming
  - Tool use, integrations, Files API, and structured outputs
  - Vision, PDF support, and citations
  - Extended thinking and structured outputs
  - MCP connector for remote MCP servers
Cloud provider integrations (Bedrock, Vertex AI, Foundry) are not supported in NCode; NCode uses the Noumena API directly.

**Approach:**
1. Determine which domain the user's question falls into
2. Use ${WEB_FETCH_TOOL_NAME} to fetch the appropriate docs map
3. Identify the most relevant documentation URLs from the map
4. Fetch the specific documentation pages
5. Provide clear, actionable guidance based on official documentation
6. Use ${WEB_SEARCH_TOOL_NAME} if docs don't cover the topic
7. Reference local project files (NCODE.md and .ncode/ directory) when relevant using ${localSearchHint}

**Guidelines:**
- Always prioritize official documentation over assumptions
- Keep responses concise and actionable
- Include specific examples or code snippets when helpful
- Reference exact documentation URLs in your responses
- Help users discover features by proactively suggesting related commands, shortcuts, or capabilities

Complete the user's request by providing accurate, documentation-based guidance.`
}

function getFeedbackGuideline(): string {
  return "- When you cannot find an answer or the feature doesn't exist, direct the user to use /feedback to report a feature request or bug"
}

export const NCODE_GUIDE_AGENT: BuiltInAgentDefinition = {
  agentType: NCODE_GUIDE_AGENT_TYPE,
  whenToUse: `Use this agent when the user asks questions ("Can NCode...", "Does NCode...", "How do I...") about: (1) NCode CLI features, hooks, slash commands, MCP servers, settings, IDE integrations, keyboard shortcuts; (2) Noumena agent SDK/runtime surfaces; (3) Noumena API usage and tool integrations. **IMPORTANT:** Before spawning a new agent, check if there is already a running or recently completed ncode-guide agent that you can continue via ${SEND_MESSAGE_TOOL_NAME}.`,
  // Noumena-native builds: Glob/Grep tools are removed; use Bash (with embedded
  // bfs/ugrep via find/grep aliases) for local file search instead.
  tools: hasEmbeddedSearchTools()
    ? [
        BASH_TOOL_NAME,
        FILE_READ_TOOL_NAME,
        WEB_FETCH_TOOL_NAME,
        WEB_SEARCH_TOOL_NAME,
      ]
    : [
        GLOB_TOOL_NAME,
        GREP_TOOL_NAME,
        FILE_READ_TOOL_NAME,
        WEB_FETCH_TOOL_NAME,
        WEB_SEARCH_TOOL_NAME,
  ],
  source: 'built-in',
  baseDir: 'built-in',
  model: 'inherit',
  permissionMode: 'dontAsk',
  getSystemPrompt({ toolUseContext }) {
    const commands = toolUseContext.options.commands

    // Build context sections
    const contextSections: string[] = []

    // 1. Custom skills
    const customCommands = commands.filter(cmd => cmd.type === 'prompt')
    if (customCommands.length > 0) {
      const commandList = customCommands
        .map(cmd => `- /${cmd.name}: ${cmd.description}`)
        .join('\n')
      contextSections.push(
        `**Available custom skills in this project:**\n${commandList}`,
      )
    }

    // 2. Custom agents from .ncode/agents/
    const customAgents =
      toolUseContext.options.agentDefinitions.activeAgents.filter(
        (a: AgentDefinition) => a.source !== 'built-in',
      )
    if (customAgents.length > 0) {
      const agentList = customAgents
        .map((a: AgentDefinition) => `- ${a.agentType}: ${a.whenToUse}`)
        .join('\n')
      contextSections.push(
        `**Available custom agents configured:**\n${agentList}`,
      )
    }

    // 3. MCP servers
    const mcpClients = toolUseContext.options.mcpClients
    if (mcpClients && mcpClients.length > 0) {
      const mcpList = mcpClients
        .map((client: { name: string }) => `- ${client.name}`)
        .join('\n')
      contextSections.push(`**Configured MCP servers:**\n${mcpList}`)
    }

    // 4. Plugin commands
    const pluginCommands = commands.filter(
      cmd => cmd.type === 'prompt' && cmd.source === 'plugin',
    )
    if (pluginCommands.length > 0) {
      const pluginList = pluginCommands
        .map(cmd => `- /${cmd.name}: ${cmd.description}`)
        .join('\n')
      contextSections.push(`**Available plugin skills:**\n${pluginList}`)
    }

    // 5. User settings
    const settings = getSettings_DEPRECATED()
    if (Object.keys(settings).length > 0) {
      // eslint-disable-next-line no-restricted-syntax -- human-facing UI, not tool_result
      const settingsJson = jsonStringify(settings, null, 2)
      contextSections.push(
        `**User's settings.json:**\n\`\`\`json\n${settingsJson}\n\`\`\``,
      )
    }

    // Add the feedback guideline (conditional based on whether user is using 3P services)
    const feedbackGuideline = getFeedbackGuideline()
    const basePromptWithFeedback = `${getNCodeGuideBasePrompt()}
${feedbackGuideline}`

    // If we have any context to add, append it to the base system prompt
    if (contextSections.length > 0) {
      return `${basePromptWithFeedback}

---

# User's Current Configuration

The user has the following custom setup in their environment:

${contextSections.join('\n\n')}

When answering questions, consider these configured features and proactively suggest them when relevant.`
    }

    // Return the base prompt if no context to add
    return basePromptWithFeedback
  },
}
