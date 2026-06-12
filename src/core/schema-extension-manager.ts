// =============================================================================
// SchemaExtensionManager —— World Package Schema 扩展管理器
// =============================================================================
// Phase 4B: 事务化 + 禁止覆盖 + 冲突提案拒绝

import type { Database } from 'better-sqlite3';

export type ExtensionType = 'predicate' | 'rule' | 'entity_template' | 'scope_preset';

export interface PredicateExtension { name: string; displayName: string; valueType: 'scalar'|'entity_ref'|'enum'; enumValues?: string[]; sequenceOrder?: string[]; description?: string; relationKind?: string; }
export interface RuleExtension { id: string; type: string; name: string; description?: string; priority?: number; definition: { id: string; type: string; name: string; description?: string; priority?: number; conditions: unknown[]; consequences?: unknown[]; }; }
export interface TemplateExtension { name: string; kind: string; extendsTemplate?: string; defaultPredicates: string[]; overridePredicates?: Record<string, unknown>; description?: string; }
export interface ScopePresetExtension { name: string; displayName: string; defaultExitBehavior?: 'suggest_promote'|'suggest_discard'; inheritsGlobalRules?: boolean; overrideRules?: unknown; description?: string; }

export interface ExtensionProposal { proposalId: string; extensionType: ExtensionType; summary: string; conflicts: string[]; data: unknown; committed: boolean; }
export interface CommitExtensionResult { status: 'success'|'failed'; schemaEventId?: string; affectedTables: string[]; newPredicateNames?: string[]; newRuleIds?: string[]; errorMessage?: string; }

export class SchemaExtensionManager {
  private proposals = new Map<string, ExtensionProposal>();
  private proposalCounter = 0;
  private db: Database;

  constructor(db: Database) { this.db = db; }

  private genId(): string { this.proposalCounter++; return `prp_schema_${String(this.proposalCounter).padStart(2,'0')}`; }

  proposePredicate(ext: PredicateExtension): ExtensionProposal {
    const conflicts: string[] = [];
    if (this.db.prepare('SELECT name FROM wp_predicates WHERE name=?').get(ext.name)) conflicts.push(`谓词'${ext.name}'已存在`);
    if (this.db.prepare('SELECT canonical_name FROM wp_predicate_aliases WHERE alias=?').get(ext.name)) conflicts.push(`'${ext.name}'已被注册为别名`);
    const p: ExtensionProposal = { proposalId: this.genId(), extensionType: 'predicate', summary: `新增谓词:${ext.name}(${ext.displayName})[${ext.valueType}]${conflicts.length?' ⚠️有冲突':''}`, conflicts, data: ext, committed: false };
    this.proposals.set(p.proposalId, p); return p;
  }

  proposeRule(ext: RuleExtension): ExtensionProposal {
    const conflicts: string[] = [];
    if (this.db.prepare('SELECT id FROM wp_rules WHERE id=?').get(ext.id)) conflicts.push(`规则ID'${ext.id}'已存在`);
    if (!ext.definition.type||!ext.definition.conditions) conflicts.push('规则缺少type/conditions');
    const p: ExtensionProposal = { proposalId: this.genId(), extensionType: 'rule', summary: `${ext.type}规则:${ext.name}(${ext.id})${conflicts.length?' ⚠️有冲突':''}`, conflicts, data: ext, committed: false };
    this.proposals.set(p.proposalId, p); return p;
  }

  proposeEntityTemplate(ext: TemplateExtension): ExtensionProposal {
    const conflicts: string[] = [];
    if (this.db.prepare('SELECT name FROM wp_entity_templates WHERE name=?').get(ext.name)) conflicts.push(`模板'${ext.name}'已存在`);
    if (ext.extendsTemplate && !this.db.prepare('SELECT name FROM wp_entity_templates WHERE name=?').get(ext.extendsTemplate)) conflicts.push(`父模板'${ext.extendsTemplate}'不存在`);
    const p: ExtensionProposal = { proposalId: this.genId(), extensionType: 'entity_template', summary: `实体模板:${ext.name}(${ext.kind})${conflicts.length?' ⚠️有冲突':''}`, conflicts, data: ext, committed: false };
    this.proposals.set(p.proposalId, p); return p;
  }

  proposeScopePreset(ext: ScopePresetExtension): ExtensionProposal {
    const conflicts: string[] = [];
    if (this.db.prepare('SELECT name FROM wp_scope_presets WHERE name=?').get(ext.name)) conflicts.push(`预设'${ext.name}'已存在`);
    const p: ExtensionProposal = { proposalId: this.genId(), extensionType: 'scope_preset', summary: `作用域预设:${ext.name}(${ext.displayName})${conflicts.length?' ⚠️有冲突':''}`, conflicts, data: ext, committed: false };
    this.proposals.set(p.proposalId, p); return p;
  }

  commitExtension(proposalId: string): CommitExtensionResult {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) return { status:'failed', affectedTables:[], errorMessage:`PROPOSAL_NOT_FOUND:${proposalId}` };
    if (proposal.committed) return { status:'failed', affectedTables:[], errorMessage:`ALREADY_COMMITTED:${proposalId}` };
    if (proposal.conflicts.length > 0) return { status:'failed', affectedTables:[], errorMessage:`CONFLICT_DETECTED:${proposal.conflicts.join(';')}` };

    try {
      const result = this.db.transaction(() => {
        const bv = (this.db.prepare("SELECT state_version FROM project_state WHERE project_id='default'").get() as {state_version:number}|undefined)?.state_version??0;
        if (this.db.prepare("UPDATE project_state SET state_version=state_version+1, updated_at=datetime('now') WHERE project_id='default' AND state_version=?").run(bv).changes===0) throw new Error('STALE_PROPOSAL');

        const at: string[] = []; const np: string[] = []; const nr: string[] = [];
        if (proposal.extensionType==='predicate') {
          const e = proposal.data as PredicateExtension;
          if (this.db.prepare('SELECT name FROM wp_predicates WHERE name=?').get(e.name)) throw new Error('CONFLICT:谓词已存在');
          this.db.prepare("INSERT INTO wp_predicates(name,display_name,value_type,enum_values,sequence_order,description,relation_kind)VALUES(?,?,?,?,?,?,?)").run(e.name,e.displayName,e.valueType,e.enumValues?JSON.stringify(e.enumValues):null,e.sequenceOrder?JSON.stringify(e.sequenceOrder):null,e.description??'',e.relationKind??'structural');
          at.push('wp_predicates'); np.push(e.name);
        } else if (proposal.extensionType==='rule') {
          const e = proposal.data as RuleExtension;
          if (this.db.prepare('SELECT id FROM wp_rules WHERE id=?').get(e.id)) throw new Error('CONFLICT:规则ID已存在');
          this.db.prepare("INSERT INTO wp_rules(id,type,name,description,priority,definition_json)VALUES(?,?,?,?,?,?)").run(e.id,e.type,e.name,e.description??'',e.priority??0,JSON.stringify(e.definition));
          at.push('wp_rules'); nr.push(e.id);
        } else if (proposal.extensionType==='entity_template') {
          const e = proposal.data as TemplateExtension;
          if (this.db.prepare('SELECT name FROM wp_entity_templates WHERE name=?').get(e.name)) throw new Error('CONFLICT:模板名已存在');
          if (e.extendsTemplate && !this.db.prepare('SELECT name FROM wp_entity_templates WHERE name=?').get(e.extendsTemplate)) throw new Error(`CONFLICT:父模板${e.extendsTemplate}不存在`);
          this.db.prepare("INSERT INTO wp_entity_templates(name,kind,extends_template,default_predicates,override_predicates,description)VALUES(?,?,?,?,?,?)").run(e.name,e.kind,e.extendsTemplate??null,JSON.stringify(e.defaultPredicates),e.overridePredicates?JSON.stringify(e.overridePredicates):null,e.description??'');
          at.push('wp_entity_templates');
        } else if (proposal.extensionType==='scope_preset') {
          const e = proposal.data as ScopePresetExtension;
          if (this.db.prepare('SELECT name FROM wp_scope_presets WHERE name=?').get(e.name)) throw new Error('CONFLICT:预设名已存在');
          this.db.prepare("INSERT INTO wp_scope_presets(name,display_name,default_exit_behavior,inherits_global_rules,override_rules,description)VALUES(?,?,?,?,?,?)").run(e.name,e.displayName,e.defaultExitBehavior??'suggest_discard',e.inheritsGlobalRules?1:0,e.overrideRules?JSON.stringify(e.overrideRules):null,e.description??'');
          at.push('wp_scope_presets');
        }
        const sq = (this.db.prepare("SELECT COUNT(*) as cnt FROM events WHERE type='schema'").get() as {cnt:number}).cnt+1;
        const seid = `evt_schema_${String(sq).padStart(2,'0')}`;
        this.db.prepare("INSERT INTO events(id,kind,type,chapter,description,params_json,context,fact_group_id,resolved_threads,dependencies_json)VALUES(?,?,?,?,?,?,?,?,?,?)").run(seid,'system','schema',0,proposal.summary,JSON.stringify({proposalId,extensionType:proposal.extensionType}),'global',seid,'[]','[]');
        this.db.prepare("INSERT INTO audit_log(event_id,tool_name,raw_input_json)VALUES(?,?,?)").run(seid,'commit_schema_extension',JSON.stringify({proposalId,extensionType:proposal.extensionType,affectedTables:at,newPredicateNames:np,newRuleIds:nr}));
        return { schemaEventId:seid, affectedTables:at, newPredicateNames:np, newRuleIds:nr };
      })();

      proposal.committed = true;
      return { status:'success', schemaEventId:result.schemaEventId, affectedTables:result.affectedTables, newPredicateNames:result.newPredicateNames.length>0?result.newPredicateNames:undefined, newRuleIds:result.newRuleIds.length>0?result.newRuleIds:undefined };
    } catch(err) {
      const m = String(err);
      if (m.includes('STALE_PROPOSAL')) return { status:'failed', affectedTables:[], errorMessage:'STALE_PROPOSAL:状态版本冲突' };
      if (m.startsWith('CONFLICT:')) return { status:'failed', affectedTables:[], errorMessage:m };
      throw err;
    }
  }

  getProposal(pid: string): ExtensionProposal|undefined { return this.proposals.get(pid); }
}
