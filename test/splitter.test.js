const assert = require('assert');
const { splitMembers } = require('../src/splitter');

const mock7Players = Array.from({ length: 7 }, (_, i) => ({
  id: `user_${i + 1}`,
  displayName: `Player_${i + 1}`,
}));

// テスト1: 7人VCで Valorant 5人優先 → 5人フルパ + 2人残り枠 に分かれること
const resValo = splitMembers(mock7Players, {
  mode: 'priority',
  prioritySize: 5,
});
assert.strictEqual(resValo.teams.length, 2, '7人×5人優先は2グループになるべき');
assert.strictEqual(resValo.teams[0].members.length, 5, '第1チームは5人フルパ');
assert.strictEqual(resValo.teams[1].members.length, 2, '残り枠は2人');
assert.strictEqual(resValo.teams[1].isRemainder, true, '第2グループは余り枠フラグがtrue');

// テスト2: 7人中1人を観戦除外した場合 → 抽選対象6人 → 5人フルパ + 1人残り枠 + 除外1人
const resExcluded = splitMembers(mock7Players, {
  mode: 'priority',
  prioritySize: 5,
  excludedIds: ['user_7'],
});
assert.strictEqual(resExcluded.activeCount, 6);
assert.strictEqual(resExcluded.excludedMembers.length, 1);
assert.strictEqual(resExcluded.teams[0].members.length, 5);
assert.strictEqual(resExcluded.teams[1].members.length, 1);

// テスト3: グループ数指定均等分け (7人を2グループ → 4人と3人)
const resGroups = splitMembers(mock7Players, {
  mode: 'groups',
  groupCount: 2,
});
assert.strictEqual(resGroups.teams.length, 2);
assert.strictEqual(resGroups.teams[0].members.length, 4);
assert.strictEqual(resGroups.teams[1].members.length, 3);

// テスト4: カスタム人数指定 ("3, 2, 2")
const resCustom = splitMembers(mock7Players, {
  mode: 'custom',
  customSizes: '3, 2, 2',
});
assert.strictEqual(resCustom.teams.length, 3);
assert.deepStrictEqual(
  resCustom.teams.map((t) => t.members.length),
  [3, 2, 2]
);

// テスト5: フルパ確定枠 (priorityIds) に指定したメンバーが必ず第1チーム（5人フルパ）に入ること
for (let trial = 0; trial < 20; trial++) {
  const resPriority = splitMembers(mock7Players, {
    mode: 'priority',
    prioritySize: 5,
    priorityIds: ['user_2', 'user_6'],
  });
  const mainTeamIds = resPriority.teams[0].members.map((m) => m.id);
  assert.ok(mainTeamIds.includes('user_2'), 'user_2 は必ずフルパ側に入る');
  assert.ok(mainTeamIds.includes('user_6'), 'user_6 は必ずフルパ側に入る');
}

console.log('✅ 全テストケース成功！');
