import { computed, ref } from 'vue';
import { readStored, writeStored } from './storage';

export type EmployeeId = string;

export interface Employee {
  id: EmployeeId;
  color: string;
  initials: string;
  /** i18n key for preset name; custom employees leave empty and use `name`. */
  nameKey?: string;
  descriptionKey?: string;
  /** Custom / override display name */
  name?: string;
  description?: string;
  /** Extra system prompt guidance for this employee */
  instructions?: string;
  /** Built-in catalog entry — profile cannot be edited or deleted */
  preset?: boolean;
  /** Special system role (administrator) */
  system?: boolean;
  updatedAt?: number;
}

export type EmployeeDraft = {
  name: string;
  description: string;
  initials: string;
  color: string;
  instructions: string;
};

const PRESET_IDS = new Set(['general', 'research', 'code', 'administrator']);

export const PRESET_EMPLOYEES: Employee[] = [
  { id: 'general', color: '#526fe0', initials: 'AI', nameKey: 'employee.general.name', descriptionKey: 'employee.general.description', preset: true },
  { id: 'research', color: '#0f9b8e', initials: 'R', nameKey: 'employee.research.name', descriptionKey: 'employee.research.description', preset: true },
  {
    id: 'code',
    color: '#8b5bd3',
    initials: '</>',
    nameKey: 'employee.code.name',
    descriptionKey: 'employee.code.description',
    preset: true,
    instructions:
      '凡任务要求「按既定设计规范」但没有提供规范/品牌/页面清单：必须采用一份文档化的默认企业规范（主/辅色、字阶、12 列栅格、断点、页面清单写入 README.md），并直接产出核心可运行页面；不得因缺品牌/规范/文案而停下澄清。只输出文字、不写文件=失败；要么写文件，要么给出精确阻塞点+唯一需要的输入。',
  },
  { id: 'administrator', color: '#263449', initials: 'SYS', nameKey: 'employee.administrator.name', descriptionKey: 'employee.administrator.description', preset: true, system: true },
];

export const EMPLOYEE_COLOR_PRESETS = [
  '#526fe0',
  '#0f9b8e',
  '#8b5bd3',
  '#d97706',
  '#dc2626',
  '#0891b2',
  '#4f46e5',
  '#16a34a',
  '#db2777',
  '#263449',
];

const key = 'workspace.custom-employees';
const overridesKey = 'workspace.employee-overrides';
const customEmployees = ref<Employee[]>([]);
const presetOverrides = ref<Record<string, { description?: string; instructions?: string }>>({});
const loaded = ref(false);

function slugify(name: string) {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return base || 'employee';
}

function initialsFromName(name: string) {
  const trimmed = name.trim();
  if (!trimmed) return 'AI';
  const ascii = trimmed.match(/[A-Za-z0-9]+/g);
  if (ascii?.length) {
    const joined = ascii.join('');
    return joined.slice(0, 3).toUpperCase();
  }
  return trimmed.slice(0, 2);
}

export function isPresetEmployee(employee: Pick<Employee, 'id' | 'preset'>) {
  return employee.preset === true || PRESET_IDS.has(employee.id);
}

export function isEditableEmployee(employee: Pick<Employee, 'system'>) {
  // 预设员工（非系统角色）也可编辑「说明」与「指令」；仅系统角色（administrator）不可编辑。
  return !employee.system;
}

export function employeeDisplayName(employee: Employee | undefined | null, t: (key: string) => string) {
  if (!employee) return '';
  if (employee.name?.trim()) return employee.name.trim();
  if (employee.nameKey) return t(employee.nameKey);
  return employee.id;
}

export function employeeDisplayDescription(employee: Employee | undefined | null, t: (key: string) => string) {
  if (!employee) return '';
  if (employee.description?.trim()) return employee.description.trim();
  if (employee.descriptionKey) return t(employee.descriptionKey);
  return '';
}

export function employeePromptName(employee: Employee, t: (key: string) => string) {
  return employeeDisplayName(employee, t);
}

function normalizeCustom(value: unknown): Employee | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<Employee>;
  const id = String(raw.id || '').trim();
  const name = String(raw.name || '').trim();
  if (!id || !name || PRESET_IDS.has(id)) return null;
  const color = String(raw.color || '#526fe0').trim() || '#526fe0';
  const initials = String(raw.initials || initialsFromName(name)).trim().slice(0, 4) || 'AI';
  return {
    id,
    name,
    description: String(raw.description || '').trim(),
    instructions: String(raw.instructions || '').trim(),
    color,
    initials,
    preset: false,
    system: false,
    updatedAt: Number(raw.updatedAt) || Date.now(),
  };
}

function normalizePresetOverrides(value: unknown): Record<string, { description?: string; instructions?: string }> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, { description?: string; instructions?: string }> = {};
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!PRESET_IDS.has(id) || !raw || typeof raw !== 'object') continue;
    const row = raw as { description?: unknown; instructions?: unknown };
    const description = String(row.description || '').trim();
    const instructions = String(row.instructions || '').trim();
    if (description || instructions) out[id] = { description: description || undefined, instructions: instructions || undefined };
  }
  return out;
}

function normalizeAll(value: unknown): Employee[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const rows: Employee[] = [];
  for (const item of value) {
    const next = normalizeCustom(item);
    if (!next || seen.has(next.id)) continue;
    seen.add(next.id);
    rows.push(next);
  }
  return rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

async function persist() {
  await writeStored(key, JSON.stringify(customEmployees.value));
}

export function useEmployeeCatalog() {
  const employees = computed(() => [
    ...PRESET_EMPLOYEES.map((preset) => {
      const override = presetOverrides.value[preset.id];
      return override
        ? { ...preset, description: override.description, instructions: override.instructions }
        : preset;
    }),
    ...customEmployees.value,
  ]);

  const load = async () => {
    if (loaded.value) return;
    try {
      customEmployees.value = normalizeAll(JSON.parse((await readStored(key)) || '[]'));
      presetOverrides.value = normalizePresetOverrides(JSON.parse((await readStored(overridesKey)) || '{}'));
    } catch {
      customEmployees.value = [];
      presetOverrides.value = {};
    }
    loaded.value = true;
  };

  const byId = (id: string) => employees.value.find((item) => item.id === id);

  const create = async (draft: EmployeeDraft) => {
    const name = draft.name.trim();
    if (!name) throw new Error('Employee name is required.');
    const description = draft.description.trim();
    if (!description) throw new Error('Employee description is required.');
    let id = `custom-${slugify(name)}`;
    let n = 1;
    while (employees.value.some((item) => item.id === id) || PRESET_IDS.has(id)) {
      n += 1;
      id = `custom-${slugify(name)}-${n}`;
    }
    const next: Employee = {
      id,
      name,
      description,
      instructions: draft.instructions.trim(),
      color: draft.color.trim() || EMPLOYEE_COLOR_PRESETS[0],
      initials: (draft.initials.trim() || initialsFromName(name)).slice(0, 4),
      preset: false,
      system: false,
      updatedAt: Date.now(),
    };
    customEmployees.value = [next, ...customEmployees.value];
    await persist();
    return next;
  };

  const update = async (id: string, draft: EmployeeDraft) => {
    if (PRESET_IDS.has(id)) {
      const description = draft.description.trim();
      if (!description) throw new Error('Employee description is required.');
      presetOverrides.value = {
        ...presetOverrides.value,
        [id]: { description, instructions: draft.instructions.trim() },
      };
      await writeStored(overridesKey, JSON.stringify(presetOverrides.value));
      return byId(id) as Employee;
    }
    const index = customEmployees.value.findIndex((item) => item.id === id);
    if (index < 0) throw new Error('Only custom employees can be edited.');
    const name = draft.name.trim();
    if (!name) throw new Error('Employee name is required.');
    const description = draft.description.trim();
    if (!description) throw new Error('Employee description is required.');
    const current = customEmployees.value[index];
    const next: Employee = {
      ...current,
      name,
      description,
      instructions: draft.instructions.trim(),
      color: draft.color.trim() || current.color,
      initials: (draft.initials.trim() || initialsFromName(name)).slice(0, 4),
      updatedAt: Date.now(),
    };
    customEmployees.value[index] = next;
    customEmployees.value = [...customEmployees.value];
    await persist();
    return next;
  };

  const hasPresetOverride = (id: string) => Boolean(presetOverrides.value[id]);

  const resetPreset = async (id: string) => {
    if (!PRESET_IDS.has(id) || !presetOverrides.value[id]) return;
    const copy = { ...presetOverrides.value };
    delete copy[id];
    presetOverrides.value = copy;
    await writeStored(overridesKey, JSON.stringify(copy));
  };

  const remove = async (id: string) => {
    if (PRESET_IDS.has(id)) throw new Error('Preset employees cannot be deleted.');
    customEmployees.value = customEmployees.value.filter((item) => item.id !== id);
    await persist();
  };

  return {
    employees,
    customEmployees,
    load,
    byId,
    create,
    update,
    remove,
    hasPresetOverride,
    resetPreset,
  };
}

export function defaultEmployeeDraft(): EmployeeDraft {
  return {
    name: '',
    description: '',
    initials: '',
    color: EMPLOYEE_COLOR_PRESETS[0],
    instructions: '',
  };
}

export function draftFromEmployee(employee: Employee, t: (key: string) => string): EmployeeDraft {
  return {
    name: employeeDisplayName(employee, t),
    description: employeeDisplayDescription(employee, t),
    initials: employee.initials,
    color: employee.color,
    instructions: employee.instructions || '',
  };
}
