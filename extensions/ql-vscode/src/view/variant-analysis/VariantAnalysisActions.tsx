import { styled } from "styled-components";
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react";
import { VariantAnalysisStatus } from "../../variant-analysis/shared/variant-analysis";
// import { isCanary } from "../../config"; // TODO: resolve build error & re-add conditional render with isCanary on View Autofixes button (or on viewAutofixesDisabled)

export type VariantAnalysisActionsProps = {
  variantAnalysisStatus: VariantAnalysisStatus;

  onStopQueryClick: () => void;
  stopQueryDisabled?: boolean;

  showResultActions?: boolean;
  onViewAutofixesClick: () => void;
  onCopyRepositoryListClick: () => void;
  onExportResultsClick: () => void;
  viewAutofixesDisabled?: boolean;
  copyRepositoryListDisabled?: boolean;
  exportResultsDisabled?: boolean;

  hasSelectedRepositories?: boolean;
  hasFilteredRepositories?: boolean;
};

const Container = styled.div`
  margin-left: auto;
  display: flex;
  gap: 1em;
`;

const Button = styled(VSCodeButton)`
  white-space: nowrap;
`;

const chooseText = ({
  hasSelectedRepositories,
  hasFilteredRepositories,
  normalText,
  selectedText,
  filteredText,
}: {
  hasSelectedRepositories?: boolean;
  hasFilteredRepositories?: boolean;
  normalText: string;
  selectedText: string;
  filteredText: string;
}) => {
  if (hasSelectedRepositories) {
    return selectedText;
  }
  if (hasFilteredRepositories) {
    return filteredText;
  }
  return normalText;
};

export const VariantAnalysisActions = ({
  variantAnalysisStatus,
  onStopQueryClick,
  stopQueryDisabled,
  showResultActions,
  onViewAutofixesClick,
  onCopyRepositoryListClick,
  onExportResultsClick,
  viewAutofixesDisabled,
  copyRepositoryListDisabled,
  exportResultsDisabled,
  hasSelectedRepositories,
  hasFilteredRepositories,
}: VariantAnalysisActionsProps) => {
  return (
    <Container>
      {showResultActions && (
        <>
          <Button
            appearance="secondary"
            onClick={onViewAutofixesClick}
            disabled={viewAutofixesDisabled}
          >
            {chooseText({
              hasSelectedRepositories,
              hasFilteredRepositories,
              normalText: "View Autofixes",
              selectedText: "View Autofixes for selected results",
              filteredText: "View Autofixes for filtered results",
            })}
          </Button>
          <Button
            appearance="secondary"
            onClick={onCopyRepositoryListClick}
            disabled={copyRepositoryListDisabled}
          >
            {chooseText({
              hasSelectedRepositories,
              hasFilteredRepositories,
              normalText: "Copy repository list",
              selectedText: "Copy selected repositories as a list",
              filteredText: "Copy filtered repositories as a list",
            })}
          </Button>
          <Button
            appearance="primary"
            onClick={onExportResultsClick}
            disabled={exportResultsDisabled}
          >
            {chooseText({
              hasSelectedRepositories,
              hasFilteredRepositories,
              normalText: "Export results",
              selectedText: "Export selected results",
              filteredText: "Export filtered results",
            })}
          </Button>
        </>
      )}
      {variantAnalysisStatus === VariantAnalysisStatus.InProgress && (
        <Button
          appearance="secondary"
          onClick={onStopQueryClick}
          disabled={stopQueryDisabled}
        >
          Stop query
        </Button>
      )}
      {variantAnalysisStatus === VariantAnalysisStatus.Canceling && (
        <Button appearance="secondary" disabled={true}>
          Stopping query
        </Button>
      )}
    </Container>
  );
};
