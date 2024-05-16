import { EnumTypeDefinitionNode, Kind, parse } from 'graphql';

export function getSubgraphNamesFromSupergraphSdl(supergraphSdl: string) {
  const supergraphAst = parse(supergraphSdl, { noLocation: true });
  const joinGraphEnum = supergraphAst.definitions.find(
    (node): node is EnumTypeDefinitionNode =>
      node.kind === Kind.ENUM_TYPE_DEFINITION && node.name.value === 'join__Graph',
  );
  if (!joinGraphEnum) {
    throw new Error('join__Graph enum not found in supergraph SDL');
  }
  if (!joinGraphEnum.values) {
    throw new Error('join__Graph enum has no values');
  }
  const subgraphNames = new Set<string>();
  for (const joinGraphEnumValue of joinGraphEnum.values) {
    subgraphNames.add(joinGraphEnumValue.name.value);
  }
  return subgraphNames;
}
