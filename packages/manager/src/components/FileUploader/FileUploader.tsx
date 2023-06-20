import { APIError } from '@linode/api-v4/lib/types';
import { useSnackbar } from 'notistack';
import * as React from 'react';
import { FileRejection, useDropzone } from 'react-dropzone';
import { useQueryClient } from 'react-query';
import { useDispatch } from 'react-redux';
import { useHistory } from 'react-router-dom';
import {
  StyledCopy,
  StyledDropZoneContentDiv,
  StyledDropZoneDiv,
  StyledFileUploadsDiv,
  StyledUploadButton,
} from 'src/components/FileUploader/FileUploader.styles';
import { uploadImageFile } from 'src/features/Images/requests';
import { FileUpload } from 'src/features/ObjectStorage/ObjectUploader/FileUpload';
import { onUploadProgressFactory } from 'src/features/ObjectStorage/ObjectUploader/ObjectUploader';
import {
  MAX_FILE_SIZE_IN_BYTES,
  MAX_PARALLEL_UPLOADS,
  curriedObjectUploaderReducer,
  defaultState,
  pathOrFileName,
} from 'src/features/ObjectStorage/ObjectUploader/reducer';
import { Dispatch } from 'src/hooks/types';
import { useCurrentToken } from 'src/hooks/useAuthentication';
import { queryKey, useUploadImageQuery } from 'src/queries/images';
import { redirectToLogin } from 'src/session';
import { setPendingUpload } from 'src/store/pendingUpload';
import { sendImageUploadEvent } from 'src/utilities/analytics';
import { readableBytes } from 'src/utilities/unitConversions';

interface FileUploaderProps {
  label: string;
  description?: string;
  isCloudInit?: boolean;
  region: string;
  dropzoneDisabled: boolean;
  apiError: string | undefined;
  setErrors: React.Dispatch<React.SetStateAction<APIError[] | undefined>>;
  // Send a function for canceling the upload back to the parent.
  setCancelFn: React.Dispatch<React.SetStateAction<(() => void) | null>>;
  onSuccess?: () => void;
}

export const FileUploader = React.memo((props: FileUploaderProps) => {
  const {
    label,
    description,
    isCloudInit,
    region,
    dropzoneDisabled,
    apiError,
    setErrors,
    onSuccess,
  } = props;

  const { enqueueSnackbar } = useSnackbar();
  const [uploadToURL, setUploadToURL] = React.useState<string>('');
  const queryClient = useQueryClient();
  const { mutateAsync: uploadImage } = useUploadImageQuery({
    label,
    region,
    description: description ? description : undefined,
    cloud_init: isCloudInit ? isCloudInit : undefined,
  });

  const history = useHistory();

  // Keep track of the session token since we may need to grab the user a new
  // one after a long upload (if their session has expired).
  const currentToken = useCurrentToken();

  const [state, dispatch] = React.useReducer(
    curriedObjectUploaderReducer,
    defaultState
  );

  const dispatchAction: Dispatch = useDispatch();

  React.useEffect(() => {
    const preventDefault = (e: any) => {
      e.preventDefault();
    };

    // This event listeners prevent the browser from opening files dropped on
    // the screen, which was happening when the dropzone was disabled.

    // eslint-disable-next-line scanjs-rules/call_addEventListener
    window.addEventListener('dragover', preventDefault);
    // eslint-disable-next-line scanjs-rules/call_addEventListener
    window.addEventListener('drop', preventDefault);

    return () => {
      window.removeEventListener('dragover', preventDefault);
      window.removeEventListener('drop', preventDefault);
    };
  }, []);

  // This function is fired when files are dropped in the upload area.
  const onDrop = (files: File[]) => {
    const prefix = '';

    // If an upload attempt failed previously, clear the dropzone.
    if (state.numErrors > 0) {
      dispatch({ type: 'CLEAR_UPLOAD_HISTORY' });
    }

    dispatch({ type: 'ENQUEUE', files, prefix });
  };

  // This function will be called when the user drops non-.gz files, more than one file at a time, or files that are over the max size.
  const onDropRejected = (files: FileRejection[]) => {
    const wrongFileType = !files[0].file.type.match(/gzip/gi);
    const fileTypeErrorMessage =
      'Only raw disk images (.img) compressed using gzip (.gz) can be uploaded.';

    const moreThanOneFile = files.length > 1;
    const fileNumberErrorMessage = 'Only one file may be uploaded at a time.';

    const fileSizeErrorMessage = `Max file size (${
      readableBytes(MAX_FILE_SIZE_IN_BYTES).formatted
    }) exceeded`;

    if (wrongFileType) {
      enqueueSnackbar(fileTypeErrorMessage, {
        variant: 'error',
        autoHideDuration: 10000,
      });
    } else if (moreThanOneFile) {
      enqueueSnackbar(fileNumberErrorMessage, {
        variant: 'error',
        autoHideDuration: 10000,
      });
    } else {
      enqueueSnackbar(fileSizeErrorMessage, {
        variant: 'error',
        autoHideDuration: 10000,
      });
    }
  };

  const nextBatch = React.useMemo(() => {
    if (state.numQueued === 0 || state.numInProgress > 0) {
      return [];
    }

    const queuedUploads = state.files.filter(
      (upload) => upload.status === 'QUEUED'
    );

    return queuedUploads.slice(0, MAX_PARALLEL_UPLOADS - state.numInProgress);
  }, [state.numQueued, state.numInProgress, state.files]);

  const uploadInProgressOrFinished =
    state.numInProgress > 0 || state.numFinished > 0;

  // When `nextBatch` changes, upload the files.
  React.useEffect(() => {
    if (nextBatch.length === 0) {
      return;
    }

    nextBatch.forEach((fileUpload) => {
      const { file } = fileUpload;

      const path = pathOrFileName(fileUpload.file);

      const onUploadProgress = onUploadProgressFactory(dispatch, path);

      const handleSuccess = () => {
        if (onSuccess) {
          onSuccess();
        }

        dispatch({
          type: 'UPDATE_FILES',
          filesToUpdate: [path],
          data: {
            percentComplete: 100,
            status: 'FINISHED',
          },
        });

        const successfulUploadMessage = `Image ${label} uploaded successfully. It is being processed and will be available shortly.`;

        enqueueSnackbar(successfulUploadMessage, {
          variant: 'success',
          autoHideDuration: 6000,
        });

        dispatchAction(setPendingUpload(false));

        recordImageAnalytics('success', file);

        // EDGE CASE:
        // The upload has finished, but the user's token has expired.
        // Show the toast, then redirect them to /images, passing them through
        // Login to get a new token.
        if (!currentToken) {
          setTimeout(() => {
            redirectToLogin('/images');
          }, 3000);
        } else {
          queryClient.invalidateQueries(`${queryKey}-list`);
          history.push('/images');
        }
      };

      const handleError = () => {
        dispatch({
          type: 'UPDATE_FILES',
          filesToUpdate: [path],
          data: {
            status: 'ERROR',
          },
        });

        dispatchAction(setPendingUpload(false));
      };

      if (!uploadToURL) {
        uploadImage()
          .then((response) => {
            setUploadToURL(response.upload_to);

            // Let the entire app know that there's a pending upload via Redux.
            // High-level components like AuthenticationWrapper need to know
            // this, so the user isn't redirected to Login if the token expires.
            dispatchAction(setPendingUpload(true));

            dispatch({
              type: 'UPDATE_FILES',
              filesToUpdate: [pathOrFileName(fileUpload.file)],
              data: { status: 'IN_PROGRESS' },
            });

            recordImageAnalytics('start', file);

            const { request, cancel } = uploadImageFile(
              response.upload_to,
              file,
              onUploadProgress
            );

            // The parent might need to cancel this upload (e.g. if the user
            // navigates away from the page).
            props.setCancelFn(() => () => cancel());

            request()
              .then(() => handleSuccess())
              .catch(() => handleError());
          })
          .catch((e) => {
            dispatch({ type: 'CLEAR_UPLOAD_HISTORY' });
            setErrors(e);
          });
      } else {
        recordImageAnalytics('start', file);

        // Overwrite any file that was previously uploaded to the upload_to URL.
        const { request, cancel } = uploadImageFile(
          uploadToURL,
          file,
          onUploadProgress
        );

        props.setCancelFn(cancel);

        request()
          .then(() => handleSuccess())
          .catch(() => {
            handleError();
            recordImageAnalytics('fail', file);
            dispatch({ type: 'CLEAR_UPLOAD_HISTORY' });
          });
      }
    });
  }, [nextBatch]);

  const {
    getInputProps,
    getRootProps,
    isDragActive,
    isDragAccept,
    isDragReject,
    open,
    acceptedFiles,
  } = useDropzone({
    onDrop,
    onDropRejected,
    disabled: dropzoneDisabled || uploadInProgressOrFinished, // disabled when dropzoneDisabled === true, an upload is in progress, or if an upload finished.
    noClick: true,
    noKeyboard: true,
    accept: ['application/x-gzip', 'application/gzip'], // Uploaded files must be compressed using gzip.
    maxFiles: 1,
    maxSize: MAX_FILE_SIZE_IN_BYTES,
  });

  const hideDropzoneBrowseBtn =
    (isDragAccept || acceptedFiles.length > 0) && !apiError; // Checking that there isn't an apiError set to prevent disappearance of button if image creation isn't available in a region at that moment, etc.

  // const UploadZoneActive =
  //   state.files.filter((upload) => upload.status !== 'QUEUED').length !== 0;

  const uploadZoneActive = state.files.length !== 0;

  const placeholder = dropzoneDisabled
    ? 'To upload an image, complete the required fields.'
    : 'You can browse your device to upload an image file or drop it here.';

  return (
    <StyledDropZoneDiv
      {...getRootProps({})}
      isDragActive={isDragActive}
      isDragAccept={isDragAccept}
      isDragReject={isDragReject}
      dropzoneDisabled={dropzoneDisabled || uploadInProgressOrFinished}
    >
      <input {...getInputProps()} placeholder={placeholder} />
      <StyledFileUploadsDiv>
        {state.files.map((upload, idx) => {
          const fileName = upload.file.name;
          return (
            <FileUpload
              key={idx}
              displayName={fileName}
              fileName={fileName}
              sizeInBytes={upload.file.size || 0}
              percentCompleted={upload.percentComplete || 0}
              overwriteNotice={upload.status === 'OVERWRITE_NOTICE'}
              dispatch={dispatch}
              error={upload.status === 'ERROR' ? 'Error uploading image.' : ''}
              type="image"
            />
          );
        })}
      </StyledFileUploadsDiv>
      <StyledDropZoneContentDiv uploadZoneActive={uploadZoneActive}>
        {!uploadZoneActive && (
          <StyledCopy variant="subtitle2">{placeholder}</StyledCopy>
        )}
        {!hideDropzoneBrowseBtn ? (
          <StyledUploadButton
            buttonType="primary"
            onClick={open}
            disabled={dropzoneDisabled}
          >
            Browse Files
          </StyledUploadButton>
        ) : null}
      </StyledDropZoneContentDiv>
    </StyledDropZoneDiv>
  );
});

const recordImageAnalytics = (
  action: 'start' | 'success' | 'fail',
  file: File
) => {
  const readableFileSize = readableBytes(file.size).formatted;
  sendImageUploadEvent(action, readableFileSize);
};
