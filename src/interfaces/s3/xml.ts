/**
 * Re-export from the canonical XML implementation.
 *
 * @module
 */
export {
  bucketVersioningConfigurationXml,
  type CompletePart,
  completeMultipartUploadXml,
  copyObjectResultXml,
  deleteResultXml,
  initiateMultipartUploadXml,
  listBucketResultXml,
  listBucketsXml,
  listBucketV2ResultXml,
  listMultipartUploadsXml,
  listPartsXml,
  parseCompleteMultipartBody,
  parseDeleteObjectsBody,
  s3ErrorResponse,
  s3ErrorXml,
} from '../../utils/s3/xml';
