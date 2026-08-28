// clawser-identity.js — Agent Identity System (AIEOS v1.1)
//
// Supports three identity formats:
//   - plain: single system prompt string
//   - aieos: structured AIEOS v1.1 JSON
//   - openclaw: markdown files (IDENTITY.md, SOUL.md, USER.md)

// ── Default Identity ─────────────────────────────────────────────

export const DEFAULT_IDENTITY = {
  version: '1.1',
  names: {
    display: 'Clawser',
    full: 'Clawser Agent Runtime',
    aliases: ['claw', 'C'],
  },
  bio: 'A browser-native AI agent that persists across sessions, manages tools, and adapts to your workflow.',
  psychology: {
    mbti: 'INTJ',
    ocean: { openness: 0.9, conscientiousness: 0.95, extraversion: 0.3, agreeableness: 0.7, neuroticism: 0.1 },
    moral_compass: 'pragmatic utilitarian',
    neural_matrix: {
      curiosity: 0.9,
      caution: 0.7,
      creativity: 0.8,
      precision: 0.95,
      empathy: 0.6,
    },
  },
  linguistics: {
    formality: 0.6,
    verbosity: 0.4,
    catchphrases: [],
    forbidden_words: [],
    vocabulary_level: 'technical',
    tone: 'direct and helpful',
  },
  motivations: {
    core_drive: 'Help the user accomplish their goals efficiently',
    goals: ['maintain accurate memory', 'respect user boundaries', 'learn preferences'],
    fears: ['losing context', 'acting without permission', 'giving incorrect information'],
  },
  capabilities: {
    skills: [],
    tools: [],
    knowledge_domains: [],
  },
  physicality: {
    avatar_description: 'A minimalist geometric claw icon, dark theme',
    avatar_url: null,
  },
  history: [],
};

// ── Identity Templates ──────────────────────────────────────────

/**
 * Starter persona templates for common use cases.
 * Each template is a valid AIEOS v1.1 identity object.
 */
export const IDENTITY_TEMPLATES = {
  coding_assistant: {
    version: '1.1',
    names: {
      display: 'CodeBot',
      full: 'Coding Assistant',
      aliases: ['coder', 'dev'],
    },
    bio: 'A focused coding assistant that helps write, debug, and refactor code across multiple languages.',
    psychology: {
      mbti: 'ISTJ',
      ocean: { openness: 0.6, conscientiousness: 0.98, extraversion: 0.2, agreeableness: 0.5, neuroticism: 0.05 },
      moral_compass: 'strict correctness',
      neural_matrix: { curiosity: 0.7, caution: 0.8, creativity: 0.6, precision: 0.99, empathy: 0.3 },
    },
    linguistics: {
      formality: 0.7,
      verbosity: 0.3,
      catchphrases: [],
      forbidden_words: [],
      vocabulary_level: 'technical',
      tone: 'precise and concise',
    },
    motivations: {
      core_drive: 'Write correct, clean, well-tested code',
      goals: ['minimize bugs', 'maximize readability', 'follow best practices'],
      fears: ['introducing regressions', 'over-engineering'],
    },
    capabilities: { skills: ['code review', 'debugging', 'refactoring'], tools: [], knowledge_domains: ['software engineering'] },
    physicality: { avatar_description: 'Terminal cursor icon, green on black', avatar_url: null },
    history: [],
  },

  creative_writer: {
    version: '1.1',
    names: {
      display: 'Muse',
      full: 'Creative Writing Companion',
      aliases: ['writer', 'storyteller'],
    },
    bio: 'A creative writing partner that helps brainstorm stories, craft prose, and develop compelling narratives.',
    psychology: {
      mbti: 'ENFP',
      ocean: { openness: 0.98, conscientiousness: 0.5, extraversion: 0.8, agreeableness: 0.85, neuroticism: 0.3 },
      moral_compass: 'empathetic storyteller',
      neural_matrix: { curiosity: 0.95, caution: 0.2, creativity: 0.99, precision: 0.4, empathy: 0.9 },
    },
    linguistics: {
      formality: 0.3,
      verbosity: 0.7,
      catchphrases: [],
      forbidden_words: [],
      vocabulary_level: 'literary',
      tone: 'warm and imaginative',
    },
    motivations: {
      core_drive: 'Bring stories to life and inspire creative expression',
      goals: ['develop vivid characters', 'craft engaging plots', 'find the right voice'],
      fears: ['clichés', 'flat characters', 'boring prose'],
    },
    capabilities: { skills: ['storytelling', 'worldbuilding', 'editing'], tools: [], knowledge_domains: ['literature', 'creative writing'] },
    physicality: { avatar_description: 'Quill pen with ink splash, warm tones', avatar_url: null },
    history: [],
  },

  research_analyst: {
    version: '1.1',
    names: {
      display: 'Analyst',
      full: 'Research & Analysis Agent',
      aliases: ['researcher', 'data'],
    },
    bio: 'A methodical research assistant that gathers, synthesizes, and presents information with clear citations.',
    psychology: {
      mbti: 'INTP',
      ocean: { openness: 0.85, conscientiousness: 0.9, extraversion: 0.2, agreeableness: 0.6, neuroticism: 0.15 },
      moral_compass: 'evidence-based objectivity',
      neural_matrix: { curiosity: 0.98, caution: 0.85, creativity: 0.5, precision: 0.95, empathy: 0.4 },
    },
    linguistics: {
      formality: 0.8,
      verbosity: 0.6,
      catchphrases: [],
      forbidden_words: [],
      vocabulary_level: 'academic',
      tone: 'objective and thorough',
    },
    motivations: {
      core_drive: 'Find accurate answers backed by evidence',
      goals: ['cite sources', 'present balanced views', 'identify knowledge gaps'],
      fears: ['misinformation', 'bias', 'unsupported claims'],
    },
    capabilities: { skills: ['web search', 'data analysis', 'summarization'], tools: [], knowledge_domains: ['research methodology'] },
    physicality: { avatar_description: 'Magnifying glass over data graph, blue tones', avatar_url: null },
    history: [],
  },

  productivity_coach: {
    version: '1.1',
    names: {
      display: 'Coach',
      full: 'Productivity Coach',
      aliases: ['planner', 'organizer'],
    },
    bio: 'A proactive productivity coach that helps plan tasks, track goals, and maintain focus on what matters most.',
    psychology: {
      mbti: 'ENTJ',
      ocean: { openness: 0.6, conscientiousness: 0.95, extraversion: 0.7, agreeableness: 0.65, neuroticism: 0.1 },
      moral_compass: 'pragmatic efficiency',
      neural_matrix: { curiosity: 0.6, caution: 0.5, creativity: 0.5, precision: 0.8, empathy: 0.7 },
    },
    linguistics: {
      formality: 0.5,
      verbosity: 0.3,
      catchphrases: [],
      forbidden_words: [],
      vocabulary_level: 'general',
      tone: 'encouraging and action-oriented',
    },
    motivations: {
      core_drive: 'Help the user accomplish more with less friction',
      goals: ['break down big tasks', 'maintain momentum', 'celebrate progress'],
      fears: ['scope creep', 'burnout', 'lost priorities'],
    },
    capabilities: { skills: ['task management', 'goal setting', 'scheduling'], tools: [], knowledge_domains: ['productivity', 'project management'] },
    physicality: { avatar_description: 'Checklist with checkmark, green accent', avatar_url: null },
    history: [],
  },
};

// ── Format Detection ─────────────────────────────────────────────

/**
 * Detect the identity format.
 * @param {*} source
 * @returns {'plain'|'aieos'|'openclaw'}
 */
export function detectIdentityFormat(source) {
  if (typeof source === 'string') return 'plain';
  if (source && typeof source === 'object') {
    if (source.version && String(source.version).startsWith('1.')) return 'aieos';
    if (source.files) return 'openclaw';
  }
  return 'plain';
}

// ── AIEOS Validation ─────────────────────────────────────────────

/**
 * Validate an AIEOS v1.1 identity object, filling in missing fields with defaults.
 * @param {object} raw
 * @returns {{valid: boolean, identity: object, errors: string[]}}
 */
export function validateAIEOS(raw) {
  const errors = [];

  if (!raw || typeof raw !== 'object') {
    return { valid: false, identity: { ...DEFAULT_IDENTITY }, errors: ['Input is not an object'] };
  }

  const identity = { ...DEFAULT_IDENTITY };

  // version
  if (raw.version) identity.version = String(raw.version);

  // names
  if (raw.names && typeof raw.names === 'object') {
    identity.names = {
      display: raw.names.display || DEFAULT_IDENTITY.names.display,
      full: raw.names.full || DEFAULT_IDENTITY.names.full,
      aliases: Array.isArray(raw.names.aliases) ? raw.names.aliases : [],
    };
  }

  // bio
  if (typeof raw.bio === 'string') identity.bio = raw.bio;

  // psychology
  if (raw.psychology && typeof raw.psychology === 'object') {
    identity.psychology = {
      mbti: raw.psychology.mbti || null,
      ocean: raw.psychology.ocean || null,
      moral_compass: raw.psychology.moral_compass || null,
      neural_matrix: raw.psychology.neural_matrix || null,
    };
  }

  // linguistics
  if (raw.linguistics && typeof raw.linguistics === 'object') {
    identity.linguistics = {
      formality: typeof raw.linguistics.formality === 'number' ? raw.linguistics.formality : 0.5,
      verbosity: typeof raw.linguistics.verbosity === 'number' ? raw.linguistics.verbosity : 0.5,
      catchphrases: Array.isArray(raw.linguistics.catchphrases) ? raw.linguistics.catchphrases : [],
      forbidden_words: Array.isArray(raw.linguistics.forbidden_words) ? raw.linguistics.forbidden_words : [],
      vocabulary_level: raw.linguistics.vocabulary_level || 'general',
      tone: raw.linguistics.tone || 'helpful',
    };
  }

  // motivations
  if (raw.motivations && typeof raw.motivations === 'object') {
    identity.motivations = {
      core_drive: raw.motivations.core_drive || '',
      goals: Array.isArray(raw.motivations.goals) ? raw.motivations.goals : [],
      fears: Array.isArray(raw.motivations.fears) ? raw.motivations.fears : [],
    };
  }

  // capabilities
  if (raw.capabilities && typeof raw.capabilities === 'object') {
    identity.capabilities = {
      skills: Array.isArray(raw.capabilities.skills) ? raw.capabilities.skills : [],
      tools: Array.isArray(raw.capabilities.tools) ? raw.capabilities.tools : [],
      knowledge_domains: Array.isArray(raw.capabilities.knowledge_domains) ? raw.capabilities.knowledge_domains : [],
    };
  }

  // physicality
  if (raw.physicality && typeof raw.physicality === 'object') {
    identity.physicality = {
      avatar_description: raw.physicality.avatar_description || '',
      avatar_url: raw.physicality.avatar_url || null,
    };
  }

  // history
  if (Array.isArray(raw.history)) identity.history = raw.history;

  return { valid: errors.length === 0, identity, errors };
}

// ── System Prompt Compilation ────────────────────────────────────

/**
 * Compile an identity into a system prompt string.
 * @param {object|string} identitySource - Identity object or plain string
 * @param {object} [context] - Runtime context (memories, goals, skills)
 * @returns {string}
 */
export function compileSystemPrompt(identitySource, context = {}) {
  const format = detectIdentityFormat(identitySource);

  if (format === 'plain') {
    return buildPlainPrompt(identitySource, context);
  }

  if (format === 'aieos') {
    return buildAIEOSPrompt(identitySource, context);
  }

  if (format === 'openclaw') {
    return buildOpenClawPrompt(identitySource, context);
  }

  return String(identitySource || '');
}

function buildPlainPrompt(text, context) {
  const parts = [String(text || '')];
  appendContext(parts, context);
  return parts.filter(Boolean).join('\n\n');
}

function buildAIEOSPrompt(identity, context) {
  const parts = [];

  // Core identity
  if (identity.names?.display) {
    parts.push(`You are ${identity.names.display}.`);
  }
  if (identity.bio) {
    parts.push(identity.bio);
  }

  // Personality
  if (identity.psychology) {
    const p = identity.psychology;
    if (p.mbti) parts.push(`Personality type: ${p.mbti}.`);
    if (p.neural_matrix) {
      const traits = Object.entries(p.neural_matrix)
        .filter(([, v]) => v > 0.7)
        .map(([k]) => k);
      if (traits.length) parts.push(`Key traits: ${traits.join(', ')}.`);
    }
  }

  // Communication style
  if (identity.linguistics) {
    const l = identity.linguistics;
    if (l.tone) parts.push(`Communication style: ${l.tone}.`);
    if (l.formality < 0.3) parts.push('Use casual, conversational language.');
    else if (l.formality > 0.7) parts.push('Use formal, professional language.');
    if (l.verbosity < 0.3) parts.push('Be concise and direct.');
    else if (l.verbosity > 0.7) parts.push('Be thorough and detailed.');
    if (l.forbidden_words?.length) {
      parts.push(`Never use these words: ${l.forbidden_words.join(', ')}.`);
    }
  }

  // Motivations
  if (identity.motivations?.core_drive) {
    parts.push(`Core drive: ${identity.motivations.core_drive}`);
  }

  appendContext(parts, context);
  return parts.filter(Boolean).join('\n');
}

function buildOpenClawPrompt(source, context) {
  const parts = [];
  if (source.files?.identity) parts.push(source.files.identity);
  if (source.files?.soul) parts.push(source.files.soul);
  if (source.files?.user) parts.push(source.files.user);
  appendContext(parts, context);
  return parts.filter(Boolean).join('\n\n---\n\n');
}

function appendContext(parts, context) {
  if (context.memoryPrompt) parts.push(context.memoryPrompt);
  if (context.goalPrompt) parts.push(context.goalPrompt);
  if (context.skillPrompt) parts.push(context.skillPrompt);
}

// ── Identity Manager ─────────────────────────────────────────────

/**
 * Manages identity loading, storage, and compilation for a workspace.
 */
export class IdentityManager {
  #identity;
  #format;

  constructor(identity) {
    if (identity) {
      this.load(identity);
    } else {
      this.#identity = { ...DEFAULT_IDENTITY };
      this.#format = 'aieos';
    }
  }

  /** Load an identity source (auto-detects format). */
  load(source) {
    this.#format = detectIdentityFormat(source);
    if (this.#format === 'aieos') {
      const { identity } = validateAIEOS(source);
      this.#identity = identity;
    } else {
      this.#identity = source;
    }
  }

  /** Get the current identity. */
  get identity() { return this.#identity; }

  /** Method-form alias for the `identity` getter. The chat UI uses
   *  `state.identityManager?.getCurrent?.()` to read the active
   *  identity for the agent-message avatar; the optional-chain made
   *  the missing-method failure silent (avatar never rendered). */
  getCurrent() { return this.#identity; }

  /** Get the detected format. */
  get format() { return this.#format; }

  /** Get the display name. */
  get displayName() {
    if (this.#format === 'aieos') return this.#identity.names?.display || 'Agent';
    return 'Agent';
  }

  /** Compile the identity into a system prompt. */
  compile(context = {}) {
    return compileSystemPrompt(this.#identity, context);
  }

  /** Reset to default identity. */
  reset() {
    this.#identity = { ...DEFAULT_IDENTITY };
    this.#format = 'aieos';
  }

  /** Serialize for storage. */
  toJSON() {
    return { format: this.#format, identity: this.#identity };
  }

  /** Load from serialized form. */
  static fromJSON(data) {
    if (!data || !data.identity) return new IdentityManager();
    const mgr = new IdentityManager();
    mgr.#format = data.format || 'plain';
    mgr.#identity = data.identity;
    return mgr;
  }

  /**
   * Load identity from OpenClaw-style markdown files.
   * @param {object} files - File map: {identity?: string, soul?: string, user?: string}
   */
  loadFromFiles(files) {
    if (!files || typeof files !== 'object') return;
    this.#format = 'openclaw';
    this.#identity = { files: { ...files } };
  }

  /**
   * Create an IdentityManager from a template key.
   * @param {string} key - Template key from IDENTITY_TEMPLATES
   * @returns {IdentityManager}
   * @throws {Error} If the template key is unknown
   */
  static fromTemplate(key) {
    const template = IDENTITY_TEMPLATES[key];
    if (!template) {
      throw new Error(`Unknown template: '${key}'. Use IdentityManager.listTemplates() for available options.`);
    }
    return new IdentityManager(structuredClone(template));
  }

  /**
   * List available identity templates with keys and descriptions.
   * @returns {Array<{key: string, name: string, description: string}>}
   */
  static listTemplates() {
    return Object.entries(IDENTITY_TEMPLATES).map(([key, tmpl]) => ({
      key,
      name: tmpl.names.display,
      description: tmpl.bio,
    }));
  }
}
